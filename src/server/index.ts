/**
 * index.ts — HTTP: SSE for events, POST for commands.
 *
 * SSE rather than WebSocket on purpose: this is one-directional streaming plus
 * discrete commands. The browser gives us reconnect semantics for free, and
 * prompt/abort are plain POSTs. A WebSocket would buy nothing and cost us a
 * framing/reconnect/ack protocol to write and debug.
 */

import express from "express";
import { createServer, type IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listModels, setDefaultModel } from "./models.js";
import { listSessions, sameProject } from "./sessions.js";
import {
	addFavorite,
	addProject,
	browse,
	listFavorites,
	listProjects,
	removeFavorite,
	removeProject,
} from "./projects.js";
import { readPersonality, writePersonality } from "./personality.js";
import { apply, status as gitStatus, suggestMessage, type GitPlan } from "./git.js";
import { nameCommit, nameSession } from "./autoname.js";
import { Terminals } from "./terminals.js";
import { Registry } from "./registry.js";
import { PI_BIN, type AskAnswer } from "./agent.js";
import { PRODUCT, type PiImage } from "../shared/types.js";
import * as packages from "./packages.js";
import { info, search } from "./gallery.js";
import { claimPort } from "./takeover.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

/*
 * Variables the previous product read, and this one does not.
 *
 * Silence would be the expensive failure here: somebody copies an env file
 * onto a systemd box, the service starts, and the wrong binary or the wrong
 * directory is only discovered when a session behaves strangely an hour
 * later. So it is a refusal to start, naming the replacement.
 */
const RETIRED: Record<string, string> = {
	PIW_OMP_BIN: "PWI_PI_BIN",
	PIW_APPROVAL_MODE: "nothing — pi has no approval modes",
	PIW_AGENT_DIR: "PWI_STATE_DIR (this server's own files) or PI_CODING_AGENT_DIR (pi's)",
};
for (const [name, replacement] of Object.entries(RETIRED)) {
	if (process.env[name] === undefined) continue;
	console.error(`[pwi] ${name} is no longer read. Use ${replacement}.`);
	process.exit(2);
}

/*
 * Every remaining `PIW_*` is the same variable under the old spelling, so the
 * rule is mechanical rather than a table of seventeen.
 *
 * This matters more than the named cases above: `PIW_PORT=8891` left in an
 * env file does not fail loudly, it starts a server on the DEFAULT port,
 * which then takes the port from something else or is simply not where the
 * browser is pointed. Same for `PIW_CWD`, where the fallback is the checkout
 * itself. An unread variable that changes behaviour is the whole reason this
 * check exists.
 */
for (const name of Object.keys(process.env)) {
	if (!name.startsWith("PIW_")) continue;
	console.error(`[pwi] ${name} is no longer read. Use PWI_${name.slice(4)}.`);
	process.exit(2);
}

const PORT = Number(process.env.PWI_PORT ?? 8890);
const CWD = resolve(process.env.PWI_CWD ?? process.argv[2] ?? process.cwd());
/** "provider/id". Pi's own default may select a provider your plan blocks. */
const MODEL = process.env.PWI_MODEL;

/**
 * Under `pnpm dev` the page is served by Vite on its own port and reaches
 * this server through Vite's proxy, so its Origin is the DEV SERVER's while
 * the proxy rewrites Host to ours (`changeOrigin`). The two no longer match,
 * and the terminal's upgrade — the one request whose origin check is ours to
 * make rather than the browser's — is refused: `ws proxy error: socket hang
 * up`, once per reconnect attempt, forever.
 *
 * So dev adds exactly one origin, the one Vite was told to listen on. Not a
 * blanket "allow localhost": any page on the machine could then open a
 * shell here. Empty unless PWI_DEV=1, which only `pnpm dev` sets, so a
 * production server's boundary is unchanged.
 */
const VITE_PORT = Number(process.env.PWI_VITE_PORT ?? 5480);
const DEV_ORIGINS = new Set(
	process.env.PWI_DEV === "1"
		? [`http://127.0.0.1:${VITE_PORT}`, `http://localhost:${VITE_PORT}`]
		: [],
);

/**
 * Whether a request's Origin may use this server: no Origin (not a browser),
 * or our own origin. "Our own" is judged by the Host header, and by
 * X-Forwarded-Host for the tailscale-serve case where the proxy sets one.
 * Same-origin is the whole policy — the page is served by this server — so
 * there is no CORS anywhere, and the terminal WebSocket upgrade (which CORS
 * would not have covered anyway) asks this same question itself.
 */
function originAllowed(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	if (!origin) return true;
	if (DEV_ORIGINS.has(origin)) return true;
	let host: string;
	try {
		host = new URL(origin).host;
	} catch {
		return false;
	}
	return host === req.headers.host || host === req.headers["x-forwarded-host"];
}

/*
 * Our own package.json, which is the one file that knows pwi's version.
 *
 * Unreadable or malformed degrades to "unknown" rather than throwing: the
 * version is a label on /api/health, and refusing to start over a label
 * would take the whole server down for the least important string in it.
 * That is the same fallback the shape check below already applies.
 */
let pkg: unknown;
try {
	pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
} catch {
	pkg = undefined;
}
const PWI_VERSION =
	pkg && typeof pkg === "object" && "version" in pkg && typeof pkg.version === "string"
		? pkg.version
		: "unknown";

// Once, at startup: the binary does not change under a running server, and
// `pi update --self` is exactly the case this exists to flag — a restarted
// server spawns the new pi, a running one keeps spawning the old. A missing
// pi is reported as no version rather than as a failed start, since
// /api/models already names the ENOENT with the fix.
const PI_VERSION = await promisify(execFile)(PI_BIN, ["--version"], { timeout: 10_000 })
	.then(({ stdout }) => stdout.trim() || undefined)
	.catch(() => undefined);

// ---------------------------------------------------------------------------
// Crash policy.
//
// Layer 1 (the workhorse) is the try/catch around every prompt() in
// registry.ts. These two are the backstop.
//
// Layer 2: unhandledRejection almost always originates in one session — a
// rejection inside an event listener, a detached async inside a tool. Node has
// crashed the process on these since v15, so surviving is opt-in.
//
// Layer 3: uncaughtException is the contentious one. Node's guidance is that
// the process is in an undefined state and should exit, and that guidance is
// correct in general — under a supervisor. Every session is persisted, so the
// worst case of a restart is one exchange rather than the work, and systemd
// with Restart=on-failure turns a nonzero exit into a logged restart. Without
// a supervisor, exiting means every other conversation dies for one bug, so
// the process stays up, marked degraded on /api/health.
//
// INVOCATION_ID is set by systemd for every unit it starts and by nothing
// else here, so it is the fact itself rather than a flag to keep in sync
// with the unit file.
// ---------------------------------------------------------------------------
const SUPERVISED = Boolean(process.env.INVOCATION_ID);
let degraded = false;

process.on("unhandledRejection", (reason) => {
	console.error("[pwi] unhandledRejection (surviving):", reason);
});

process.on("uncaughtException", (err) => {
	if (SUPERVISED) {
		console.error("[pwi] uncaughtException — exiting for the supervisor to restart:", err);
		process.exit(1);
	}
	degraded = true;
	console.error(
		"[pwi] uncaughtException — PROCESS IS DEGRADED, restart when convenient:",
		err,
	);
});

const registry = new Registry(CWD, MODEL);
const terminals = new Terminals();
const app = express();
// Generous because a prompt body now carries base64 screenshots, and base64
// inflates by ~33%. The real per-image ceiling is enforced in agent.ts, where
// a rejection can be reported to the user; hitting THIS limit yields an
// opaque 413, so it deliberately sits well above the limit that produces a
// good error.
app.use(express.json({ limit: "64mb" }));

// `no-store` on every /api answer. Nothing under /api is worth caching — the
// page polls it — and an Express ETag makes these revalidatable, which is how
// a stale 304 ends up standing in for a live answer.
app.use("/api", (_req, res, next) => {
	res.setHeader("Cache-Control", "no-store");
	next();
});

app.get("/api/health", (_req, res) => {
	// `pid` is what lets the NEXT pwi take this port without a /proc scan;
	// see takeover.ts, which also checks `product` before killing anything.
	res.json({
		ok: true,
		product: PRODUCT,
		cwd: CWD,
		model: MODEL ?? null,
		degraded,
		pid: process.pid,
		pwiVersion: PWI_VERSION,
		piVersion: PI_VERSION ?? null,
	});
});

app.get("/api/models", async (_req, res) => {
	try {
		res.json({ models: await listModels() });
	} catch (err) {
		res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/** Persist "provider/id" as pi's own startup default, for future sessions. */
app.post("/api/default-model", async (req, res) => {
	const model = typeof req.body?.model === "string" ? req.body.model : undefined;
	if (!model) return res.status(400).json({ error: "model required" });
	try {
		await setDefaultModel(model);
		// A prewarmed session booted under the OLD default, and handing that to
		// the next `+ New` would quietly ignore the change the user just made.
		registry.discardSpares();
		res.json({ ok: true });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Projects: the directories whose sessions we show. A project IS a cwd — pi
 * already partitions sessions by working directory, so this list is the only
 * new state in the feature.
 */
app.get("/api/projects", (_req, res) => {
	res.json({ projects: listProjects(CWD), active: CWD });
});

app.post("/api/projects", (req, res) => {
	const path = typeof req.body?.path === "string" ? req.body.path : "";
	if (!path.trim()) return res.status(400).json({ error: "path required" });
	try {
		// addProject validates existence + directory-ness: the path comes from the
		// browser, and a typo would otherwise mint a session dir for a ghost cwd.
		res.json({ projects: addProject(CWD, path) });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

app.delete("/api/projects", (req, res) => {
	const path = typeof req.body?.path === "string" ? req.body.path : "";
	res.json({ projects: removeProject(CWD, path) });
});

/**
 * Subdirectories of one directory, for the project picker.
 *
 * A GET with the path in the query string, so browsing is a plain navigation
 * the browser can cache and retry: this reads the filesystem and changes
 * nothing. Unreadable or missing paths are a 400 with the OS message (EACCES,
 * ENOENT) — the picker shows it and stays where it was, which is the only
 * useful answer to "that folder is not yours to read".
 */
app.get("/api/browse", (req, res) => {
	const path = typeof req.query.path === "string" ? req.query.path : "";
	try {
		res.json(browse(path));
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Favourites: directories pinned in the picker, as one-click starting points.
 *
 * Server-side state rather than a browser preference, because these are paths
 * on the machine pwi runs on — a per-origin copy would follow the browser to
 * a machine where the paths mean nothing.
 */
app.get("/api/favorites", (_req, res) => {
	res.json({ favorites: listFavorites() });
});

app.post("/api/favorites", (req, res) => {
	const path = typeof req.body?.path === "string" ? req.body.path : "";
	if (!path.trim()) return res.status(400).json({ error: "path required" });
	try {
		res.json({ favorites: addFavorite(path) });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

app.delete("/api/favorites", (req, res) => {
	const path = typeof req.body?.path === "string" ? req.body.path : "";
	res.json({ favorites: removeFavorite(path) });
});

/**
 * Personality: extra system-prompt text this server owns, at
 * `<state dir>/personality.md`.
 *
 * pi has no personality file of its own; the text is passed to each child as
 * `--append-system-prompt`. A new session picks up a change because each
 * session is its own pi child; sessions already running keep the prompt they
 * were started with.
 */
app.get("/api/personality", (_req, res) => {
	res.json(readPersonality());
});

app.put("/api/personality", (req, res) => {
	if (typeof req.body?.content !== "string") {
		return res.status(400).json({ error: "content required" });
	}
	try {
		res.json(writePersonality(req.body.content));
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/** Flat, read-only session list for one project. No tree — use the TUI for branching. */
app.get("/api/sessions", async (req, res) => {
	try {
		const cwd = typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : CWD;
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
		res.json({
			sessions: sessions.map((s) => ({
				...s,
				isStreaming: streamingIds.has(s.id),
			})),
		});
	} catch (err) {
		res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Rename a session.
 *
 * Addressed by file OR by id, because both callers are real: the session list
 * knows files (a row may be a session nobody has opened), and an open tab
 * knows its live id. pi does the write — see PiSession.setName — so the name
 * lands in the JSONL as a `session_info` entry and the TUI shows it too.
 */
app.post("/api/sessions/rename", async (req, res) => {
	const file = typeof req.body?.file === "string" ? req.body.file : undefined;
	const id = typeof req.body?.id === "string" ? req.body.id : undefined;
	const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
	if (!file && !id) return res.status(400).json({ error: "file or id required" });
	if (!name) return res.status(400).json({ error: "name required" });
	try {
		res.json({ name: await registry.rename(id, file, name) });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Name the session from its opening request.
 *
 * pi has no `/rename` command and no titler of its own, so the name is
 * generated here by one stateless print-mode child (see autoname.ts) and
 * written through `set_session_name`, which is synchronous and needs no
 * polling.
 */
app.post("/api/sessions/autoname", async (req, res) => {
	const file = typeof req.body?.file === "string" ? req.body.file : undefined;
	const id = typeof req.body?.id === "string" ? req.body.id : undefined;
	if (!file && !id) return res.status(400).json({ error: "file or id required" });
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
			return res.status(400).json({ error: "this session has no messages to name yet" });
		}
		res.json({ name: await registry.rename(entry.id, undefined, await nameSession(entry.session.cwd, opening)) });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/** Open an existing session (by file) or create a new one. Returns a full snapshot. */
app.post("/api/sessions/open", async (req, res) => {
	try {
		const file = typeof req.body?.file === "string" ? req.body.file : undefined;
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
		const rawCwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : "";
		if (typeof req.body?.cwd === "string" && !rawCwd) {
			return res.status(400).json({ error: "cwd must not be blank" });
		}
		// Omitting cwd entirely still means "this server's project", which is what
		// a single-project launch (PWI_CWD) relies on.
		const cwd = rawCwd || undefined;
		if (cwd && !file && !(existsSync(cwd) && statSync(cwd).isDirectory())) {
			return res.status(400).json({ error: `not a directory: ${cwd}` });
		}
		const model = typeof req.body?.model === "string" ? req.body.model : undefined;

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
			return res.status(404).json({ error: "session file not found" });
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
			return res.status(409).json({
				error: `session belongs to ${entry.session.cwd}`,
				cwd: entry.session.cwd,
			});
		}

		res.json(registry.snapshot(entry, entry.id));
	} catch (err) {
		res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Full snapshot. The client calls this on attach and whenever it is in any
 * doubt — refetching the whole thing is always correct and always cheap enough.
 */
app.get("/api/sessions/:id", (req, res) => {
	const entry = registry.get(req.params.id);
	if (!entry) return res.status(404).json({ error: "not found" });
	res.json(registry.snapshot(entry, req.params.id));
});

/**
 * Re-read this session's slash commands.
 *
 * pi pushes nothing when the set changes — installing a package, or editing
 * a prompt template in `.pi/prompts`, changes what `/` should offer with no
 * event to say so. The composer therefore asks when its menu opens, and
 * caches the answer briefly; a session's catalog changes on the order of a
 * package install, not a keystroke.
 */
app.post("/api/sessions/:id/commands", async (req, res) => {
	const entry = registry.get(req.params.id);
	if (!entry) return res.status(404).json({ error: "not found" });
	try {
		res.json({ commands: await entry.session.refreshCommands() });
	} catch (err) {
		res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Event stream. Disconnecting does NOT abort the run — that is only ever an
 * explicit user action via /abort.
 */
app.get("/api/sessions/:id/events", (req, res) => {
	const entry = registry.get(req.params.id);
	if (!entry) return res.status(404).end();

	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": connected\n\n");

	const detach = registry.attach(req.params.id, (event) => {
		res.write(`data: ${JSON.stringify(event)}\n\n`);
	});

	const keepalive = setInterval(() => res.write(": ping\n\n"), 15_000);

	req.on("close", () => {
		clearInterval(keepalive);
		detach();
	});
});

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

app.post("/api/sessions/:id/prompt", async (req, res) => {
	const text = typeof req.body?.text === "string" ? req.body.text : "";

	let images: PiImage[];
	try {
		images = parseImages(req.body?.images);
	} catch (err) {
		return res
			.status(400)
			.json({ error: err instanceof Error ? err.message : String(err) });
	}

	// An image alone is a legitimate prompt ("what is this?" is implied by
	// pasting a screenshot), so emptiness is only an error when BOTH are empty.
	if (!text.trim() && images.length === 0)
		return res.status(400).json({ error: "empty prompt" });
	if (!registry.get(req.params.id)) return res.status(404).json({ error: "not found" });

	// Fire and forget. registry.prompt resolves once pi ACCEPTS the prompt,
	// which is not when the run finishes — the turn plays out over SSE either
	// way, and scheduling failures are caught inside registry.prompt and
	// delivered as an error event rather than as an HTTP status.
	void registry.prompt(req.params.id, text, images);
	res.json({ ok: true });
});

app.post("/api/sessions/:id/abort", async (req, res) => {
	await registry.abort(req.params.id);
	res.json({ ok: true });
});

/**
 * Compact the conversation.
 *
 * Answers as soon as pi accepts the command; the fold itself arrives as
 * `compaction_start` / `compaction_end` over SSE, which is what moves the
 * transcript and the context meter.
 */
app.post("/api/sessions/:id/compact", async (req, res) => {
	try {
		await registry.compact(req.params.id);
		res.json({ ok: true });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Restart this session's pi child, so it picks up packages installed since
 * it started. The conversation is on disk and the id comes from the file, so
 * the session survives; only the process is replaced.
 */
app.post("/api/sessions/:id/restart", async (req, res) => {
	try {
		const entry = await registry.restart(req.params.id);
		res.json(registry.snapshot(entry, entry.id));
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Answer the question pi is blocked on.
 *
 * `askId` is pi's own request id and is required: a click and a timeout can
 * cross, and an answer without it would land on whichever dialog happened to
 * be open. A stale one is a 409, not an error — the page simply has an old
 * panel on screen and its next snapshot will say so.
 */
app.post("/api/sessions/:id/ask", (req, res) => {
	const askId = typeof req.body?.askId === "string" ? req.body.askId : "";
	if (!askId) return res.status(400).json({ error: "askId required" });
	if (!registry.get(req.params.id)) return res.status(404).json({ error: "not found" });

	const body = req.body ?? {};
	const answer: AskAnswer | null =
		typeof body.value === "string"
			? { value: body.value }
			: typeof body.confirmed === "boolean"
				? { confirmed: body.confirmed }
				: body.cancelled === true
					? { cancelled: true }
					: null;
	if (!answer)
		return res
			.status(400)
			.json({ error: "answer needs one of value, confirmed, cancelled" });

	if (!registry.answerAsk(req.params.id, askId, answer))
		return res.status(409).json({ error: "that question is no longer open" });
	res.json({ ok: true });
});

app.post("/api/sessions/:id/model", async (req, res) => {
	const model = typeof req.body?.model === "string" ? req.body.model : undefined;
	if (!model) return res.status(400).json({ error: "model required" });
	try {
		await registry.setModel(req.params.id, model);
		res.json({ ok: true });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Git: what the commit button can offer, and doing it.
 *
 * `cwd` is the project, not the server's own: the button belongs to the
 * session on screen, and a pwi serving several projects would otherwise
 * commit in whichever one it was started in.
 */
app.get("/api/git", async (req, res) => {
	const cwd = typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : CWD;
	const [state, message] = await Promise.all([gitStatus(cwd), suggestMessage(cwd)]);
	res.json({ ...state, suggestion: message });
});

/**
 * The commit message, written by a model that read the diff.
 *
 * Its own endpoint rather than a flag on the POST above, because `apply` is
 * deterministic git and stays that way: the name is chosen, shown and
 * editable BEFORE anything is staged, and a plan that quietly spawned a
 * model mid-commit would be a surprise inside the one operation here that
 * must not have any.
 *
 * 502, not 500: the failure is always the model or its credentials, and the
 * UI offers the file-list suggestion instead.
 */
app.post("/api/git/name", async (req, res) => {
	const cwd = typeof req.body?.cwd === "string" && req.body.cwd ? req.body.cwd : CWD;
	try {
		res.json({ message: await nameCommit(cwd) });
	} catch (err) {
		res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

app.post("/api/git", async (req, res) => {
	const cwd = typeof req.body?.cwd === "string" && req.body.cwd ? req.body.cwd : CWD;
	const plan: GitPlan = {
		branch:
			typeof req.body?.branch === "string" && req.body.branch
				? req.body.branch
				: undefined,
		message: typeof req.body?.message === "string" ? req.body.message : undefined,
		push: req.body?.push === true,
		pr: req.body?.pr === true,
	};
	if (!plan.branch && plan.message === undefined && !plan.push && !plan.pr)
		return res.status(400).json({ error: "nothing to do" });

	const result = await apply(cwd, plan);
	// 200 either way: a refused commit ("nothing to commit") is an answer the
	// UI shows verbatim, not a transport failure.
	res.json(result);
});

app.post("/api/sessions/:id/thinking", async (req, res) => {
	const level = typeof req.body?.level === "string" ? req.body.level : undefined;
	if (!level) return res.status(400).json({ error: "level required" });
	try {
		await registry.setThinkingLevel(req.params.id, level);
		res.json({ ok: true });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * Packages: what this machine has installed, and changing it.
 *
 * These routes are remote code execution by design — a pi package's
 * extensions are code and its skills instruct the model — which is the same
 * class of exposure as /api/terminals, already on this port. They inherit
 * that boundary and must not widen it: same loopback listener, same origin
 * guard, no new surface.
 */
app.get("/api/packages", async (_req, res) => {
	try {
		res.json({ piVersion: PI_VERSION ?? null, ...(await packages.view()) });
	} catch (err) {
		res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/** A mutation answers with its own outcome; the log tail is the interesting part. */
function mutation(
	res: express.Response,
	work: () => Promise<{ ok: boolean; log: string; reason?: string }>,
): Promise<void> {
	return work().then(
		(result) => {
			// A prewarmed spare booted under the OLD package set, and handing
			// that to the next `+ New` would give somebody a session that is
			// stale before they have typed anything.
			if (result.ok) registry.discardSpares();
			// 200 either way: a refused install is an answer the screen shows
			// verbatim, not a transport failure.
			res.json(result);
		},
		(err: unknown) => {
			// Only validation lands here, and it is the user's input that is wrong.
			res.status(400).json({
				ok: false,
				log: "",
				reason: err instanceof Error ? err.message : String(err),
			});
		},
	);
}

app.post("/api/packages", async (req, res) => {
	const source = typeof req.body?.source === "string" ? req.body.source : "";
	if (!source) return res.status(400).json({ ok: false, log: "", reason: "source required" });
	await mutation(res, () => packages.install(source));
});

app.delete("/api/packages", async (req, res) => {
	const source = typeof req.body?.source === "string" ? req.body.source : "";
	if (!source) return res.status(400).json({ ok: false, log: "", reason: "source required" });
	await mutation(res, () => packages.remove(source));
});

app.post("/api/packages/update", async (req, res) => {
	const source = typeof req.body?.source === "string" ? req.body.source : undefined;
	await mutation(res, () => packages.update(source));
});

/** Update the pi CLI on this machine. Never automatic. */
app.post("/api/packages/update-pi", async (_req, res) => {
	await mutation(res, () => packages.updateSelf());
});

app.get("/api/packages/search", async (req, res) => {
	const q = typeof req.query.q === "string" ? req.query.q : "";
	res.json(await search(q));
});

app.get("/api/packages/info", async (req, res) => {
	const name = typeof req.query.name === "string" ? req.query.name : "";
	if (!name) return res.status(400).json({ error: "name required" });
	try {
		res.json(await info(name));
	} catch (err) {
		res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

/**
 * The open project's own packages, read-only.
 *
 * `pi install -l` writes `.pi/settings.json`, the project commits it, and pi
 * installs anything missing at startup once the project is trusted. Git is
 * the sync for these, so this server shows them and changes nothing: a
 * second writer of a file that is in someone's repository is a merge
 * conflict waiting to be blamed on the wrong tool.
 */
app.get("/api/packages/project", (req, res) => {
	const cwd = typeof req.query.cwd === "string" && req.query.cwd ? req.query.cwd : CWD;
	res.json({ cwd, packages: packages.listProject(cwd) });
});

/**
 * Terminals: HTTP creates, lists and kills them; the SHELL itself talks over
 * the WebSocket below, because a terminal is bidirectional and SSE is not.
 * Everything else in this app is request/response or server-push, so this is
 * the one place that needed a second protocol.
 *
 * The list is what lets a reloaded client recover: it persists a layout of
 * ids and this says which of them still exist.
 */
app.get("/api/terminals", (req, res) => {
	const cwd = typeof req.query.cwd === "string" ? req.query.cwd : undefined;
	res.json({ terminals: terminals.list(cwd) });
});

app.post("/api/terminals", (req, res) => {
	const cwd = typeof req.body?.cwd === "string" && req.body.cwd ? req.body.cwd : CWD;
	const cols = Number(req.body?.cols) || 80;
	const rows = Number(req.body?.rows) || 24;
	try {
		const term = terminals.create(cwd, cols, rows);
		res.json({ id: term.id, cwd: term.cwd, running: true });
	} catch (err) {
		res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
	}
});

app.delete("/api/terminals/:id", (req, res) => {
	terminals.close(req.params.id);
	res.json({ ok: true });
});

/*
 * An unknown /api path is a 404, and it has to be declared BEFORE the SPA
 * fallback below. Otherwise the catch-all answers it with index.html and a
 * 200, so a client calling an endpoint this build does not have gets HTML
 * where it expected JSON — which is exactly how a browser running new code
 * against an older server presents as a control stuck on "loading…" rather
 * than as a version mismatch.
 */
app.use("/api", (_req, res) => {
	res.status(404).json({ error: "no such endpoint" });
});

/*
 * In production serve the built client; in dev, Vite proxies /api here instead.
 *
 * `PWI_DEV` (set only by `pnpm dev`, which always starts Vite) turns the
 * static half OFF and sends the browser to the dev server instead. Without
 * it this port keeps answering with whatever `dist/` was last built, which
 * during development is by definition stale: the page looks alive, the API
 * behind it is the one you are editing, and the only symptom of the mismatch
 * is that your changes are not there. A redirect to the port that does have
 * them is the honest answer, and it costs one line of config to say so.
 */
const dist = resolve(ROOT, "dist");
if (process.env.PWI_DEV === "1") {
	app.get("*", (req, res) =>
		res.redirect(302, `http://127.0.0.1:${VITE_PORT}${req.originalUrl}`),
	);
} else if (existsSync(dist)) {
	app.use(express.static(dist));
	app.get("*", (_req, res) => res.sendFile(resolve(dist, "index.html")));
}

const server = createServer(app);

/**
 * The terminal socket: `/api/terminal/socket?id=<terminal>`.
 *
 * `noServer` and a manual upgrade, not `new WebSocketServer({ server })`,
 * because this process has exactly one WebSocket path and everything else on
 * the port is HTTP — an attached-to-server ws would answer upgrades on any
 * path, including a typo'd one, with a socket that then goes silent.
 *
 * Messages are JSON in both directions. `input` is not raw frames: a resize
 * has to travel the same ordered channel as the keystrokes around it, or a
 * full-screen program redraws at the wrong size for exactly as long as the
 * two are out of order.
 */
const sockets = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	// A foreign page cannot fetch a terminal id without passing CORS, but a
	// socket to a guessed one would be a shell; refuse at the same boundary.
	if (url.pathname !== "/api/terminal/socket" || !originAllowed(req)) {
		socket.destroy();
		return;
	}
	const id = url.searchParams.get("id") ?? "";
	const cols = Number(url.searchParams.get("cols")) || 80;
	const rows = Number(url.searchParams.get("rows")) || 24;

	sockets.handleUpgrade(req, socket, head, (ws) => {
		/*
		 * Creating is the POST above, never this: a socket that created its own
		 * terminal would mint a second shell every time a flaky connection
		 * reconnected, and the client's layout would be pointing at the first
		 * one. An unknown id is therefore an error, which is exactly the state
		 * a restored layout hits after the server has been restarted.
		 */
		if (!terminals.get(id)) {
			ws.send(JSON.stringify({ type: "error", message: "no such terminal" }));
			ws.close();
			return;
		}

		terminals.resize(id, cols, rows);
		const detach = terminals.attach(id, (e) => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
		});

		ws.on("message", (raw) => {
			let msg: unknown;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (!msg || typeof msg !== "object") return;
			const m = msg as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
			if (m.type === "input" && typeof m.data === "string") terminals.write(id, m.data);
			else if (
				m.type === "resize" &&
				typeof m.cols === "number" &&
				typeof m.rows === "number"
			)
				terminals.resize(id, m.cols, m.rows);
		});

		// Detach only. The shell keeps running: closing a tab mid-build must
		// not kill the build, which is the same promise sessions make.
		ws.on("close", detach);
		ws.on("error", detach);
	});
});

// Loopback only, and the exposure is worse than credential theft: anyone who
// reaches this port can start an agent run, and the pi children execute every
// tool they choose — there are no approval modes to fall back on, and they are
// spawned with `--approve` so that project-local extensions load. Tunnel it
// (ssh -L) or put it on a private overlay network; never bind it publicly.
/*
 * Restarting pwi is always a takeover: the port is fixed, and the thing
 * holding it is the pwi you are replacing. Doing it by hand (find the pid,
 * kill it, start again) was three steps of pure ceremony, so the server does
 * it — but ONLY after the occupant identifies itself as a pwi on
 * /api/health. PWI_TAKEOVER=0 restores the old "fail and tell you" behaviour,
 * which is what you want under a supervisor that could otherwise have two
 * units killing each other in a loop.
 */
if (process.env.PWI_TAKEOVER !== "0") {
	try {
		await claimPort(PORT);
	} catch (err) {
		console.error(`[pwi] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

server.listen(PORT, "127.0.0.1", () => {
	console.log(`[pwi] http://127.0.0.1:${PORT}  cwd=${CWD}`);
});

// Failing to bind is not a session-scoped error, so "survive and degrade" is
// the wrong policy: it leaves a live process with no listener. Exit loudly.
server.on("error", (err: NodeJS.ErrnoException) => {
	console.error(
		err.code === "EADDRINUSE"
			? `[pwi] port ${PORT} already in use — kill the other server or set PWI_PORT`
			: `[pwi] listen failed: ${err.message}`,
	);
	process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		registry.disposeAll();
		// SIGHUP to each shell, so a restart does not leave orphaned children
		// holding the project's files (and, under takeover, its ports).
		terminals.disposeAll();
		server.close(() => process.exit(0));
		/*
		 * closeAllConnections is not belt-and-braces here, it is the only thing
		 * that makes shutdown terminate. server.close() stops accepting new
		 * sockets and then waits for the open ones to end — and an SSE stream
		 * never ends on its own, so a single attached browser tab kept the
		 * process alive indefinitely (measured: still running 20s after SIGTERM).
		 * Under `Restart=always` that turns every restart into a TimeoutStopSec
		 * wait followed by SIGKILL.
		 */
		server.closeAllConnections();
		/*
		 * An upgraded socket is no longer one of the server's HTTP
		 * connections, so closeAllConnections does not touch it while
		 * server.close() still waits for it: one attached terminal tab was
		 * enough to leave this process alive with its listener already closed
		 * — a state systemd reads as "running", so Restart=always never fires
		 * and the port stays dead until somebody kills the pid by hand.
		 */
		for (const ws of sockets.clients) ws.terminate();
		/*
		 * And a backstop for any handle nobody anticipated. unref'd, so it
		 * cannot delay a shutdown that completes on its own; it only bounds
		 * one that does not.
		 */
		setTimeout(() => process.exit(0), 2_000).unref();
	});
}
