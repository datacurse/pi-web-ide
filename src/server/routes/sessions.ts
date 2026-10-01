import { Hono } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { existsSync, statSync } from "node:fs";
import { listSessions, sameProject } from "../sessions.js";
import { searchSessions } from "../search.js";
import { readFile as readReviewFile, writeReviewed } from "../files.js";
import { resolve as resolveHunks } from "../../shared/hunks.js";
import { nameSession } from "../autoname.js";
import { type AskAnswer } from "../agent.js";
import { type PiImage } from "../../shared/types.js";
import { query, json, type Deps, type Env } from "../http.js";

/** Sessions: listing, search, naming, opening, the event stream, and every per-session command. */
export function sessionsRoutes({ cwd: CWD, registry }: Deps) {
	/** Shape-check attachments here so malformed input 400s instead of reaching pi. */
	function parseImages(raw: unknown): PiImage[] {
		if (!Array.isArray(raw)) return [];
		return raw.map((i: any) => {
			if (typeof i?.data !== "string" || typeof i?.mimeType !== "string") {
				throw new Error("each image needs { data, mimeType }");
			}
			return { data: i.data, mimeType: i.mimeType };
		});
	}

	return new Hono<Env>()
		/** Flat, read-only session list for one project. No tree — use the TUI for branching. */
		.get("/sessions", query<{ cwd?: string }>(), async (c) => {
			try {
				const cwd = c.req.query("cwd") || CWD;
				const sessions = await listSessions(cwd);

				/*
				 * The list poll is also the only continuous signal of which project the
				 * user is looking at, which is exactly what `+ New` will need a warm
				 * session for. Guarded on the directory existing for the same reason the
				 * open route is: pi cannot be launched in a directory that is not there.
				 */
				if (existsSync(cwd) && statSync(cwd).isDirectory()) registry.prewarm(cwd);

				// Streaming status only exists for sessions the registry has open (cached
				// or attached); everything on disk but not live is implicitly idle.
				const streamingIds = registry.streamingIds();
				const askingIds = registry.askingIds();
				return c.json({
					sessions: sessions.map((s) => ({
						...s,
						isStreaming: streamingIds.has(s.id),
						needsInput: askingIds.has(s.id),
					})),
					live: registry.liveFiles(),
				}, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		/** Full-text search over one project's sessions. Before `/api/sessions/:id`, which would swallow it. */
		.get("/sessions/search", query<{ cwd?: string; q?: string; word?: string }>(), async (c) => {
			try {
				const cwd = c.req.query("cwd") || CWD;
				const q = c.req.query("q") ?? "";
				return c.json({ hits: await searchSessions(cwd, q, c.req.query("word") === "1") }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		/**
		 * Rename a session.
		 *
		 * Addressed by file OR by id, because both callers are real: the session list
		 * knows files (a row may be a session nobody has opened), and an open tab
		 * knows its live id. pi does the write — see PiSession.setName — so the name
		 * lands in the JSONL as a `session_info` entry and the TUI shows it too.
		 */
		.post("/sessions/rename", json<{ file?: string; id?: string; name: string }>(), async (c) => {
			const b = c.req.valid("json");
			const file = typeof b.file === "string" ? b.file : undefined;
			const id = typeof b.id === "string" ? b.id : undefined;
			const name = typeof b.name === "string" ? b.name.trim() : "";
			if (!file && !id) return c.json({ error: "file or id required" }, 400);
			if (!name) return c.json({ error: "name required" }, 400);
			try {
				return c.json({ name: await registry.rename(id, file, name) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * Name the session from its opening request.
		 *
		 * pi has no `/rename` command and no titler of its own, so the name is
		 * generated here by one stateless print-mode child (see autoname.ts) and
		 * written through `set_session_name`, which is synchronous and needs no
		 * polling.
		 */
		.post("/sessions/autoname", json<{ file?: string; id?: string }>(), async (c) => {
			const b = c.req.valid("json");
			const file = typeof b.file === "string" ? b.file : undefined;
			const id = typeof b.id === "string" ? b.id : undefined;
			if (!file && !id) return c.json({ error: "file or id required" }, 400);
			try {
				const entry = await registry.acquire(id, file);
				// The FIRST user turn: the request the session was opened to serve.
				// Later turns are follow-ups and would name the session after its most
				// recent detour.
				const opening = entry.session
					.messages()
					.find((m) => m.role === "user")
					?.blocks.filter((b) => b.kind === "text")
					.map((b) => b.text)
					.join("\n");
				if (!opening?.trim()) {
					return c.json({ error: "this session has no messages to name yet" }, 400);
				}
				return c.json({ name: await registry.rename(entry.id, undefined, await nameSession(entry.session.cwd, opening)) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/** Open an existing session (by file) or create a new one. Returns a full snapshot. */
		.post("/sessions/open", json<{ file?: string; cwd?: string; model?: string }>(), async (c) => {
			const b = c.req.valid("json");
			try {
				const file = typeof b.file === "string" ? b.file : undefined;
				/*
				 * Only used when CREATING (no file): resuming reads cwd from the session
				 * header.
				 *
				 * A blank cwd is a client bug, not "unspecified", and it used to be
				 * silent and expensive: "" falls through `cwd ?? this.cwd` and Node's
				 * spawn treats it as "inherit", so the child landed in the SERVER's own
				 * directory. The session was then created against a project the user had
				 * not selected — pwi's own parent directory, in the case that found this
				 * — and its tools read and wrote the wrong tree. The browser sends a
				 * blank cwd whenever a session is created before /api/projects has
				 * answered, so this is reachable by clicking `+ New` early.
				 */
				const rawCwd = typeof b.cwd === "string" ? b.cwd.trim() : "";
				if (typeof b.cwd === "string" && !rawCwd) {
					return c.json({ error: "cwd must not be blank" }, 400);
				}
				// Omitting cwd entirely still means "this server's project", which is what
				// a single-project launch (PWI_CWD) relies on.
				const cwd = rawCwd || undefined;
				if (cwd && !file && !(existsSync(cwd) && statSync(cwd).isDirectory())) {
					return c.json({ error: `not a directory: ${cwd}` }, 400);
				}
				const model = typeof b.model === "string" ? b.model : undefined;

				/*
				 * Opening a nonexistent path CREATES a session there, which is right for
				 * `+ New` (no file given) and wrong for "resume this file": a client
				 * restoring a remembered session that has since been deleted would
				 * resurrect it as an empty ghost instead of being told it is gone.
				 *
				 * But absence on disk does NOT mean gone: the JSONL is written lazily, so
				 * a session created by `+ New` and not yet prompted has a path and no file.
				 * Reloading right after `+ New` must not 404. The registry is therefore the
				 * first authority and the filesystem only the fallback — known to the
				 * server means live, whatever the disk says.
				 */
				if (file && !registry.hasFile(file) && !existsSync(file)) {
					return c.json({ error: "session file not found" }, 404);
				}

				const entry = await registry.acquire(undefined, file, model, cwd);

				/*
				 * A session's project is its own: openSession launches the child in the
				 * cwd from the file's header, whatever the client asked for. So a
				 * remembered tab naming a session that belongs to ANOTHER project would
				 * otherwise be served here and displayed under the selected one — which
				 * is how the wrong-project session found in the wild stayed visible.
				 *
				 * Checked on the live session rather than on the file's header, because a
				 * session created and not yet prompted has no file on disk to read a
				 * header from, and the registry is the authority for exactly that case.
				 * Compared canonically: a cwd recorded through a symlink is the same
				 * project. The session stays open — it is somebody's, just not this
				 * project's.
				 */
				if (cwd && !(await sameProject(entry.session.cwd, cwd))) {
					return c.json({
						error: `session belongs to ${entry.session.cwd}`,
						cwd: entry.session.cwd,
					}, 409);
				}

				/*
				 * This is the reattach path, not just the create path: restoring a tab
				 * opens the remembered file, and `acquire` hands back the entry already
				 * in the map — with the message list its child accumulated, which is the
				 * one that goes stale when another pi writes the same session. Checking
				 * only on GET /api/sessions/:id missed it, because a reload comes
				 * through here first.
				 */
				await registry.refreshIfFileIsAhead(entry.id);
				const fresh = registry.get(entry.id) ?? entry;
				return c.json(registry.snapshot(fresh, entry.id), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		/**
		 * Full snapshot. The client calls this on attach and whenever it is in any
		 * doubt — refetching the whole thing is always correct and always cheap enough.
		 */
		.get("/sessions/:id", async (c) => {
			if (!registry.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
			// Asking for the session fresh is how a reload starts, and an error from a
			// turn that is no longer running has nothing to say about it.
			registry.clearDeadError(c.req.param("id"));
			// A reload is also when "somebody else wrote this session" is worth paying
			// a file read to notice. May dispose and reopen the entry, so read it back
			// afterwards rather than answering from the one we were holding.
			await registry.refreshIfFileIsAhead(c.req.param("id"));
			const entry = registry.get(c.req.param("id"));
			if (!entry) return c.json({ error: "not found" }, 404);
			return c.json(registry.snapshot(entry, c.req.param("id")), 200);
		})

		/**
		 * Re-read this session's slash commands.
		 *
		 * pi pushes nothing when the set changes — installing a package, or editing
		 * a prompt template in `.pi/prompts`, changes what `/` should offer with no
		 * event to say so. The composer therefore asks when its menu opens, and
		 * caches the answer briefly; a session's catalog changes on the order of a
		 * package install, not a keystroke.
		 */
		.post("/sessions/:id/commands", async (c) => {
			const entry = registry.get(c.req.param("id"));
			if (!entry) return c.json({ error: "not found" }, 404);
			try {
				return c.json({ commands: await entry.session.refreshCommands() }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		/**
		 * Event stream. Disconnecting does NOT abort the run — that is only ever an
		 * explicit user action via /abort.
		 */
		.get("/sessions/:id/events", (c) => {
			const entry = registry.get(c.req.param("id"));
			if (!entry) return c.body(null, 404);
			// Same reasoning as the snapshot route: a client attaching a new stream is
			// not the client that saw the old failure.
			registry.clearDeadError(c.req.param("id"));

			// Written to Node's response directly, byte for byte what the client has
			// always parsed; Hono is told the response is already being sent.
			const res = c.env.outgoing;
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			res.write(": connected\n\n");

			const detach = registry.attach(c.req.param("id"), (event) => {
				res.write(`data: ${JSON.stringify(event)}\n\n`);
			});

			const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);

			// The response's close, not the request's: the adapter drains request
			// bodies, and a request can end long before the client goes away.
			res.on("close", () => {
				clearInterval(keepalive);
				detach();
			});
			return RESPONSE_ALREADY_SENT;
		})

		.post("/sessions/:id/prompt", json<{ text: string; images?: PiImage[] }>(), async (c) => {
			const b = c.req.valid("json");
			const text = typeof b.text === "string" ? b.text : "";

			let images: PiImage[];
			try {
				images = parseImages(b.images);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}

			// An image alone is a legitimate prompt ("what is this?" is implied by
			// pasting a screenshot), so emptiness is only an error when BOTH are empty.
			if (!text.trim() && images.length === 0)
				return c.json({ error: "empty prompt" }, 400);
			if (!registry.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);

			// Fire and forget. registry.prompt resolves once pi ACCEPTS the prompt,
			// which is not when the run finishes — the turn plays out over SSE either
			// way, and scheduling failures are caught inside registry.prompt and
			// delivered as an error event rather than as an HTTP status.
			void registry.prompt(c.req.param("id"), text, images);
			return c.json({ ok: true }, 200);
		})

		/**
		 * Edit the user message that started at `at`: everything from it on is
		 * dropped from the conversation and `text` is sent in its place.
		 */
		.post("/sessions/:id/edit", json<{ at: number; text: string; images?: PiImage[] }>(), async (c) => {
			const b = c.req.valid("json");
			if (typeof b.at !== "number") return c.json({ error: "at must be a message timestamp" }, 400);
			const text = typeof b.text === "string" ? b.text : "";
			let images: PiImage[];
			try {
				images = parseImages(b.images);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
			if (!text.trim() && images.length === 0) return c.json({ error: "empty prompt" }, 400);
			try {
				await registry.edit(c.req.param("id"), b.at, text, images);
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/** What the fixed part of the context is made of, for the context popup. */
		.get("/sessions/:id/context", async (c) => {
			try {
				return c.json(await registry.contextBreakdown(c.req.param("id")), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.post("/sessions/:id/abort", async (c) => {
			await registry.abort(c.req.param("id"));
			return c.json({ ok: true }, 200);
		})

		/**
		 * Compact the conversation.
		 *
		 * Answers as soon as pi accepts the command; the fold itself arrives as
		 * `compaction_start` / `compaction_end` over SSE, which is what moves the
		 * transcript and the context meter.
		 */
		.post("/sessions/:id/compact", json<{ customInstructions?: string }>(), async (c) => {
			const b = c.req.valid("json");
			const instructions = b.customInstructions;
			if (instructions !== undefined && typeof instructions !== "string")
				return c.json({ error: "customInstructions must be a string" }, 400);
			try {
				await registry.compact(c.req.param("id"), instructions);
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * Fork the session after one of its answers (`at`: the answer's start
		 * timestamp). Answers with the new session's file; the client opens it like
		 * any other.
		 */
		.post("/sessions/:id/fork", json<{ at: number }>(), async (c) => {
			const b = c.req.valid("json");
			const at = b.at;
			if (typeof at !== "number") return c.json({ error: "at must be a message timestamp" }, 400);
			try {
				const entry = await registry.fork(c.req.param("id"), at);
				return c.json({ file: entry.session.file }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * Restart this session's pi child, so it picks up packages installed since
		 * it started. The conversation is on disk and the id comes from the file, so
		 * the session survives; only the process is replaced.
		 */
		.post("/sessions/:id/restart", async (c) => {
			try {
				const entry = await registry.restart(c.req.param("id"));
				return c.json(registry.snapshot(entry, entry.id), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * Answer the question pi is blocked on.
		 *
		 * `askId` is pi's own request id and is required: a click and a timeout can
		 * cross, and an answer without it would land on whichever dialog happened to
		 * be open. A stale one is a 409, not an error — the page simply has an old
		 * panel on screen and its next snapshot will say so.
		 */
		.post("/sessions/:id/ask", json<{ askId: string; value?: string; confirmed?: boolean; cancelled?: boolean }>(), async (c) => {
			const b = c.req.valid("json");
			const askId = typeof b.askId === "string" ? b.askId : "";
			if (!askId) return c.json({ error: "askId required" }, 400);
			if (!registry.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);

			const body = b;
			const answer: AskAnswer | null =
				typeof body.value === "string"
					? { value: body.value }
					: typeof body.confirmed === "boolean"
						? { confirmed: body.confirmed }
						: body.cancelled === true
							? { cancelled: true }
							: null;
			if (!answer)
				return c.json({ error: "answer needs one of value, confirmed, cancelled" }, 400);

			if (!registry.answerAsk(c.req.param("id"), askId, answer))
				return c.json({ error: "that question is no longer open" }, 409);
			return c.json({ ok: true }, 200);
		})

		/**
		 * Accept or reject one hunk.
		 *
		 * Accepting records a decision and writes NOTHING: pi's edit tool already put
		 * the agent's text on disk, so "accept" means "reviewed, keeping it".
		 * Rejecting is the branch that writes, putting the old text back.
		 *
		 * The write happens BEFORE the state is recorded, and a failed write leaves
		 * the hunk pending. The other order would let a refused write — a file that
		 * moved, a path outside the project — leave the pane showing a revert that
		 * never reached the disk.
		 */
		.post("/sessions/:id/hunks/:hunkId", json<{ state: "accepted" | "rejected" | "pending" }>(), async (c) => {
			const b = c.req.valid("json");
			const state: unknown = b.state;
			if (state !== "accepted" && state !== "rejected" && state !== "pending") {
				return c.json({ error: "state must be accepted, rejected or pending" }, 400);
			}
			const entry = registry.get(c.req.param("id"));
			if (!entry) return c.json({ error: "not found" }, 404);
			const hunk = entry.session.hunks.find((h) => h.id === c.req.param("hunkId"));
			if (!hunk) return c.json({ error: "no such hunk" }, 404);

			try {
				if (state === "rejected") {
					const current = readReviewFile(CWD, hunk.path) ?? "";
					// One hunk, not all of them: reverting is per-decision, and folding in
					// the others would undo changes the user has not ruled on.
					writeReviewed(CWD, hunk.path, current, resolveHunks(current, [{ ...hunk, state }]));
				}
				registry.setHunkState(c.req.param("id"), c.req.param("hunkId"), state);
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
			}
		})

		.post("/sessions/:id/model", json<{ model: string }>(), async (c) => {
			const b = c.req.valid("json");
			const model = typeof b.model === "string" ? b.model : undefined;
			if (!model) return c.json({ error: "model required" }, 400);
			try {
				await registry.setModel(c.req.param("id"), model);
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.post("/sessions/:id/fast", json<{ enabled: boolean }>(), async (c) => {
			const { enabled } = c.req.valid("json");
			if (typeof enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
			try {
				await registry.setFastMode(c.req.param("id"), enabled);
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.post("/sessions/:id/thinking", json<{ level: string }>(), async (c) => {
			const b = c.req.valid("json");
			const level = typeof b.level === "string" ? b.level : undefined;
			if (!level) return c.json({ error: "level required" }, 400);
			try {
				await registry.setThinkingLevel(c.req.param("id"), level);
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		});
}
