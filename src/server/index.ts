/**
 * index.ts — HTTP: SSE for events, POST for commands.
 *
 * SSE rather than WebSocket on purpose: this is one-directional streaming plus
 * discrete commands. The browser gives us reconnect semantics for free, and
 * prompt/abort are plain POSTs. A WebSocket would buy nothing and cost us a
 * framing/reconnect/ack protocol to write and debug.
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { getMimeType } from "hono/utils/mime";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createStreamBody } from "@hono/node-server/utils/stream";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { basename, dirname, join, resolve } from "node:path";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { listModels, readSettings, setDefaultModel, setDefaultThinkingLevel } from "./models.js";
import { listSessions, sameProject } from "./sessions.js";
import { searchSessions } from "./search.js";
import { stats } from "./stats.js";
import { syncMachines } from "./machines.js";
import { fetchUsage, pollUsage, readHistory } from "./usage.js";
import { fleet, startPwi, validTarget } from "./fleet.js";
import {
	addFavorite,
	addProject,
	browse,
	listFavorites,
	listProjects,
	removeFavorite,
	removeProject,
} from "./projects.js";
import { readPersonality, writePersonality, writeRemind } from "./personality.js";
import {
	copyEntry,
	createEntry,
	listDir,
	moveEntry,
	readFile as readReviewFile,
	safePath,
	trashEntry,
	writeFile,
	writeReviewed,
} from "./files.js";
import { resolve as resolveHunks } from "../shared/hunks.js";
import {
	apply,
	changes as gitChanges,
	log as gitLog,
	show as gitShow,
	status as gitStatus,
	suggestMessage,
	type GitPlan,
} from "./git.js";
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
/**
 * Whether the Host names this machine: loopback, or its tailnet name or
 * address as `tailscale serve` passes it through. Without this, a page on
 * any domain that re-resolves to 127.0.0.1 (DNS rebinding) is same-origin
 * with us, and the Origin check above passes it.
 */
/** One request header by lower-case name; shared by Hono routes and the raw WebSocket upgrade. */
type Header = (name: string) => string | undefined;

function hostAllowed(header: Header): boolean {
	let name: string;
	try {
		name = new URL(`http://${header("host") ?? ""}`).hostname.replace(/\.$/, "");
	} catch {
		return false;
	}
	if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
	// A MagicDNS short name has no dot; a rebinding domain always has one.
	if (!name.includes(".") || name.endsWith(".ts.net")) return true;
	// Tailscale's CGNAT range, 100.64.0.0/10.
	const m = /^100\.(\d+)\.\d+\.\d+$/.exec(name);
	return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

function originAllowed(header: Header): boolean {
	const origin = header("origin");
	if (!origin) return true;
	if (DEV_ORIGINS.has(origin)) return true;
	let host: string;
	try {
		host = new URL(origin).host;
	} catch {
		return false;
	}
	return host === header("host") || host === header("x-forwarded-host");
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

/**
 * This process, as a value a page can compare against.
 *
 * A restart replaces the JS and CSS the browser is running, but the page
 * that was already open keeps the old bundle: a tab left overnight talks to
 * a server built from different source, and the failure is silent and
 * strange rather than loud. `pid` would almost do — it is already here — but
 * it is reused after enough churn, and a random value cannot be.
 */
const BOOT = randomUUID();

const registry = new Registry(CWD, MODEL);
const terminals = new Terminals(`pwi-${PORT}`);
/** `HttpBindings` puts Node's own req/res in `c.env`, for the routes that stream. */
type Env = { Bindings: HttpBindings };
const app = new Hono<Env>();

app.use("/api/*", async (c, next) => {
	const header: Header = (name) => c.req.header(name);
	if (!hostAllowed(header) || !originAllowed(header)) return c.json({ error: "forbidden" }, 403);
	await next();
});

// Generous because a prompt body now carries base64 screenshots, and base64
// inflates by ~33%. The real per-image ceiling is enforced in agent.ts, where
// a rejection can be reported to the user; hitting THIS limit yields an
// opaque 413, so it deliberately sits well above the limit that produces a
// good error. It also bounds /api/upload.
app.use(
	"/api/*",
	bodyLimit({
		maxSize: 64 * 1024 * 1024,
		onError: (c) => c.json({ error: "request body too large" }, 413),
	}),
);

// `no-store` on every /api answer. Nothing under /api is worth caching — the
// page polls it — and a revalidatable answer is how a stale 304 once stood
// in for a live one.
app.use("/api/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

// A handler that throws answers 500 with its message, instead of escaping to
// the unhandledRejection backstop and leaving the request hanging.
app.onError((err, c) => {
	if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
	console.error("[pwi] request failed:", err);
	return c.json({ error: err.message }, 500);
});

/**
 * The JSON body as an object, `{}` when there is none.
 *
 * Only `application/json` is parsed, as express.json did: a text/plain or
 * form POST is what a foreign page can send without a preflight, and it
 * stays empty here even before the origin check refuses it.
 */
async function readBody(c: Context<Env>): Promise<Record<string, unknown>> {
	if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return {};
	const text = await c.req.text();
	if (!text.trim()) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new HTTPException(400, { message: "invalid JSON body" });
	}
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

app.get("/api/health", (c) => {
	// `pid` is what lets the NEXT pwi take this port without a /proc scan;
	// see takeover.ts, which also checks `product` before killing anything.
	return c.json({
		ok: true,
		product: PRODUCT,
		cwd: CWD,
		model: MODEL ?? null,
		degraded,
		pid: process.pid,
		boot: BOOT,
		pwiVersion: PWI_VERSION,
		piVersion: PI_VERSION ?? null,
	});
});

app.get("/api/models", async (c) => {
	try {
		const { defaultProvider: p, defaultModel: m, defaultThinkingLevel: t } = readSettings();
		return c.json({
			models: await listModels(),
			default: p && m ? `${p}/${m}` : null,
			defaultThinking: typeof t === "string" ? t : null,
		});
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/** Claude subscription limits (server/usage.ts), with their recorded history for the pace charts. */
app.get("/api/usage", async (c) => {
	const r = await fetchUsage();
	if ("error" in r) return c.json({ error: r.error }, 502);
	return c.json({ ...r.body, history: readHistory() });
});

/** `?sync=1` first brings other machines' mirrors up to date (throttled); `?sync=force` always does. */
app.get("/api/stats", async (c) => {
	try {
		if (c.req.query("sync")) await syncMachines(c.req.query("sync") === "force");
		return c.json(await stats());
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/** Every tailnet machine with its pwi link and state (server/fleet.ts). */
app.get("/api/fleet", async (c) => {
	try {
		return c.json({ machines: await fleet() });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
	}
});

/** Start pwi on another machine over ssh and serve it on the tailnet. */
app.post("/api/fleet/start", async (c) => {
	const b = await readBody(c);
	const target = b.ssh;
	if (!validTarget(target)) return c.json({ error: "bad ssh target" }, 400);
	try {
		await startPwi(target);
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
	}
});

/** Persist "provider/id" as pi's own startup default, for future sessions; `null` clears it. */
app.post("/api/default-model", async (c) => {
	const b = await readBody(c);
	const model = b.model;
	if (model !== null && (typeof model !== "string" || !model)) {
		return c.json({ error: "model required" }, 400);
	}
	try {
		await setDefaultModel(model);
		// A prewarmed session booted under the OLD default, and handing that to
		// the next `+ New` would quietly ignore the change the user just made.
		registry.discardSpares();
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/** Persist pi's startup reasoning level for future sessions; `null` clears it. */
app.post("/api/default-thinking", async (c) => {
	const b = await readBody(c);
	const level = b.level;
	if (level !== null && (typeof level !== "string" || !level)) {
		return c.json({ error: "level required" }, 400);
	}
	try {
		setDefaultThinkingLevel(level);
		registry.discardSpares(); // same reason as /api/default-model
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/**
 * Projects: the directories whose sessions we show. A project IS a cwd — pi
 * already partitions sessions by working directory, so this list is the only
 * new state in the feature.
 */
app.get("/api/projects", (c) => {
	return c.json({ projects: listProjects(CWD), active: CWD });
});

app.post("/api/projects", async (c) => {
	const b = await readBody(c);
	const path = typeof b.path === "string" ? b.path : "";
	if (!path.trim()) return c.json({ error: "path required" }, 400);
	try {
		// addProject validates existence + directory-ness: the path comes from the
		// browser, and a typo would otherwise mint a session dir for a ghost cwd.
		return c.json({ projects: addProject(CWD, path) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

app.delete("/api/projects", async (c) => {
	const b = await readBody(c);
	const path = typeof b.path === "string" ? b.path : "";
	return c.json({ projects: removeProject(CWD, path) });
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
app.get("/api/browse", (c) => {
	const path = c.req.query("path") ?? "";
	try {
		return c.json(browse(path));
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/**
 * Favourites: directories pinned in the picker, as one-click starting points.
 *
 * Server-side state rather than a browser preference, because these are paths
 * on the machine pwi runs on — a per-origin copy would follow the browser to
 * a machine where the paths mean nothing.
 */
app.get("/api/favorites", (c) => {
	return c.json({ favorites: listFavorites() });
});

app.post("/api/favorites", async (c) => {
	const b = await readBody(c);
	const path = typeof b.path === "string" ? b.path : "";
	if (!path.trim()) return c.json({ error: "path required" }, 400);
	try {
		return c.json({ favorites: addFavorite(path) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

app.delete("/api/favorites", async (c) => {
	const b = await readBody(c);
	const path = typeof b.path === "string" ? b.path : "";
	return c.json({ favorites: removeFavorite(path) });
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
app.get("/api/personality", (c) => {
	return c.json(readPersonality());
});

/** The "Repeat before every reply" toggle. Applies to sessions started after it. */
app.put("/api/personality/remind", async (c) => {
	const b = await readBody(c);
	if (typeof b.remind !== "boolean") {
		return c.json({ error: "remind must be a boolean" }, 400);
	}
	return c.json(writeRemind(b.remind));
});

app.put("/api/personality", async (c) => {
	const b = await readBody(c);
	if (typeof b.content !== "string") {
		return c.json({ error: "content required" }, 400);
	}
	try {
		return c.json(writePersonality(b.content));
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/** Flat, read-only session list for one project. No tree — use the TUI for branching. */
app.get("/api/sessions", async (c) => {
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
		});
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/** Full-text search over one project's sessions. Before `/api/sessions/:id`, which would swallow it. */
app.get("/api/sessions/search", async (c) => {
	try {
		const cwd = c.req.query("cwd") || CWD;
		const q = c.req.query("q") ?? "";
		return c.json({ hits: await searchSessions(cwd, q) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
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
app.post("/api/sessions/rename", async (c) => {
	const b = await readBody(c);
	const file = typeof b.file === "string" ? b.file : undefined;
	const id = typeof b.id === "string" ? b.id : undefined;
	const name = typeof b.name === "string" ? b.name.trim() : "";
	if (!file && !id) return c.json({ error: "file or id required" }, 400);
	if (!name) return c.json({ error: "name required" }, 400);
	try {
		return c.json({ name: await registry.rename(id, file, name) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
app.post("/api/sessions/autoname", async (c) => {
	const b = await readBody(c);
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
		return c.json({ name: await registry.rename(entry.id, undefined, await nameSession(entry.session.cwd, opening)) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/** Open an existing session (by file) or create a new one. Returns a full snapshot. */
app.post("/api/sessions/open", async (c) => {
	const b = await readBody(c);
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
		return c.json(registry.snapshot(fresh, entry.id));
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/**
 * Full snapshot. The client calls this on attach and whenever it is in any
 * doubt — refetching the whole thing is always correct and always cheap enough.
 */
app.get("/api/sessions/:id", async (c) => {
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
	return c.json(registry.snapshot(entry, c.req.param("id")));
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
app.post("/api/sessions/:id/commands", async (c) => {
	const entry = registry.get(c.req.param("id"));
	if (!entry) return c.json({ error: "not found" }, 404);
	try {
		return c.json({ commands: await entry.session.refreshCommands() });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/**
 * Event stream. Disconnecting does NOT abort the run — that is only ever an
 * explicit user action via /abort.
 */
app.get("/api/sessions/:id/events", (c) => {
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

app.post("/api/sessions/:id/prompt", async (c) => {
	const b = await readBody(c);
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
	return c.json({ ok: true });
});

app.post("/api/sessions/:id/abort", async (c) => {
	await registry.abort(c.req.param("id"));
	return c.json({ ok: true });
});

/**
 * Compact the conversation.
 *
 * Answers as soon as pi accepts the command; the fold itself arrives as
 * `compaction_start` / `compaction_end` over SSE, which is what moves the
 * transcript and the context meter.
 */
app.post("/api/sessions/:id/compact", async (c) => {
	const b = await readBody(c);
	const instructions = b.customInstructions;
	if (instructions !== undefined && typeof instructions !== "string")
		return c.json({ error: "customInstructions must be a string" }, 400);
	try {
		await registry.compact(c.req.param("id"), instructions);
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/**
 * Fork the session after one of its answers (`at`: the answer's start
 * timestamp). Answers with the new session's file; the client opens it like
 * any other.
 */
app.post("/api/sessions/:id/fork", async (c) => {
	const b = await readBody(c);
	const at = b.at;
	if (typeof at !== "number") return c.json({ error: "at must be a message timestamp" }, 400);
	try {
		const entry = await registry.fork(c.req.param("id"), at);
		return c.json({ file: entry.session.file });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/**
 * Restart this session's pi child, so it picks up packages installed since
 * it started. The conversation is on disk and the id comes from the file, so
 * the session survives; only the process is replaced.
 */
app.post("/api/sessions/:id/restart", async (c) => {
	try {
		const entry = await registry.restart(c.req.param("id"));
		return c.json(registry.snapshot(entry, entry.id));
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
app.post("/api/sessions/:id/ask", async (c) => {
	const b = await readBody(c);
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
	return c.json({ ok: true });
});

/**
 * The file behind a hunk, as it is RIGHT NOW.
 *
 * The pane diffs against live contents rather than anything remembered: the
 * agent may have edited the same file again, or the user in their own editor,
 * and a review rendered from a stale copy would offer to revert text that is
 * no longer there.
 */
app.get("/api/file", (c) => {
	const path = c.req.query("path") ?? "";
	try {
		return c.json({ path, content: readReviewFile(CWD, path) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/**
 * Save a file the user edited.
 *
 * `expect` is what the editor had when it opened the buffer, and a mismatch is
 * a 409 rather than a write. The agent edits these same files, so "someone
 * else saved while this tab was open" is the NORMAL case here, not a rare
 * race — and the only safe answer is to refuse and let the UI offer a reload.
 */
app.put("/api/file", async (c) => {
	const b = await readBody(c);
	const path = typeof b.path === "string" ? b.path : "";
	const content = typeof b.content === "string" ? b.content : null;
	const expect = typeof b.expect === "string" ? b.expect : null;
	if (content === null || expect === null) {
		return c.json({ error: "path, content and expect are required" }, 400);
	}
	try {
		writeFile(CWD, path, expect, content);
		return c.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// A stale buffer is a conflict the client can resolve by reloading; a bad
		// path is the client's bug. Different statuses so the UI can tell them
		// apart without parsing the message.
		return c.json({ error: message }, message.includes("changed on disk") ? 409 : 400);
	}
});

/**
 * A file picked in the browser, which may be on another machine than pi.
 * Saved under the temp dir so the agent can read it by path; each upload gets
 * its own folder so the original name is kept without collisions.
 */
app.post("/api/upload", async (c) => {
	const name = basename(c.req.query("name") ?? "");
	if (!name || name === "." || name === "..") return c.json({ error: "name required" }, 400);
	const data = Buffer.from(await c.req.arrayBuffer());
	try {
		const dir = join(tmpdir(), "pwi-uploads", randomUUID());
		mkdirSync(dir, { recursive: true });
		const path = join(dir, name);
		writeFileSync(path, data);
		return c.json({ path });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/**
 * A file as a download, for the explorer's "Download". Raw bytes and no size
 * cap: unlike /api/file it is streamed to disk, never rendered.
 */
app.get("/api/download", (c) => {
	try {
		const full = safePath(CWD, c.req.query("path") ?? "");
		const stat = statSync(full);
		if (!stat.isFile()) throw new Error(`not a file: ${full}`);
		const name = basename(full);
		return c.body(createStreamBody(createReadStream(full)), 200, {
			"Content-Type": getMimeType(name) ?? "application/octet-stream",
			"Content-Length": String(stat.size),
			"Content-Disposition": attachment(name),
		});
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/**
 * The explorer's file operations. Each takes paths the browser names, so all
 * of them go through files.ts's project check; none overwrites an existing
 * target, and delete moves to the desktop Trash rather than unlinking.
 */
/**
 * `Content-Disposition` for a download: an ASCII `filename` every browser
 * reads, plus RFC 5987 `filename*` carrying the real name when it is not ASCII.
 */
function attachment(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "?").replace(/["\\]/g, "\\$&");
	if (!/[^\x20-\x7e]/.test(name)) return `attachment; filename="${ascii}"`;
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const fileOp = (run: (body: Record<string, unknown>) => string | void) => async (c: Context<Env>) => {
	const b = await readBody(c);
	try {
		return c.json({ ok: true, path: run(b) || null });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
};
app.post("/api/files/create", fileOp((b) => createEntry(CWD, str(b.path), b.dir === true)));
app.post("/api/files/move", fileOp((b) => moveEntry(CWD, str(b.from), str(b.to))));
app.post("/api/files/copy", fileOp((b) => copyEntry(CWD, str(b.from), str(b.toDir))));
app.post("/api/files/trash", fileOp((b) => trashEntry(CWD, str(b.path))));

/** One directory's files and subdirectories, for the editor's tree. */
app.get("/api/files", (c) => {
	const path = c.req.query("path") ?? "";
	try {
		return c.json({ path, entries: listDir(CWD, path || CWD) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

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
app.post("/api/sessions/:id/hunks/:hunkId", async (c) => {
	const b = await readBody(c);
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
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
	}
});

app.post("/api/sessions/:id/model", async (c) => {
	const b = await readBody(c);
	const model = typeof b.model === "string" ? b.model : undefined;
	if (!model) return c.json({ error: "model required" }, 400);
	try {
		await registry.setModel(c.req.param("id"), model);
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

/**
 * Git: what the commit button can offer, and doing it.
 *
 * `cwd` is the project, not the server's own: the button belongs to the
 * session on screen, and a pwi serving several projects would otherwise
 * commit in whichever one it was started in.
 */
app.get("/api/git", async (c) => {
	const cwd = c.req.query("cwd") || CWD;
	const [state, message] = await Promise.all([gitStatus(cwd), suggestMessage(cwd)]);
	return c.json({ ...state, suggestion: message });
});

/**
 * Which paths are uncommitted, and how. NAMES only, no content.
 *
 * What the source-control panel's top half reads. Deliberately git and not
 * the session's own hunk list: hunks only exist for edits THIS server process
 * watched a tool make, so they miss anything from another session, from
 * before a restart, or from your own editor — while the commit button counts
 * all of it. One source for both, and the panel stops disagreeing with the
 * button.
 */
app.get("/api/git/changes", async (c) => {
	const cwd = c.req.query("cwd") || CWD;
	return c.json({ files: await gitChanges(cwd) });
});

/**
 * Recent commits with the paths each touched: the panel's bottom half.
 *
 * A fixed window rather than a paged log, because this is a tree you glance
 * at to find the change you just made — scrolling back through a repo's
 * history is what a real git client is for.
 */
app.get("/api/git/log", async (c) => {
	const cwd = c.req.query("cwd") || CWD;
	const limit = Number(c.req.query("limit"));
	return c.json({ commits: await gitLog(cwd, Number.isFinite(limit) ? limit : undefined) });
});

/**
 * One file's two sides, for a diff tab.
 *
 * Per file and not per panel: the list shows names, and only an opened diff
 * pays for content. `ref` empty is the working tree; a sha is that commit
 * against its parent.
 */
app.get("/api/git/show", async (c) => {
	const cwd = c.req.query("cwd") || CWD;
	const path = c.req.query("path") ?? "";
	const ref = c.req.query("ref") ?? "";
	if (!path) return c.json({ error: "path required" }, 400);
	try {
		return c.json(await gitShow(cwd, path, ref));
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
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
app.post("/api/git/name", async (c) => {
	const b = await readBody(c);
	const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : CWD;
	try {
		return c.json({ message: await nameCommit(cwd) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
	}
});

app.post("/api/git", async (c) => {
	const b = await readBody(c);
	const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : CWD;
	const plan: GitPlan = {
		branch:
			typeof b.branch === "string" && b.branch
				? b.branch
				: undefined,
		message: typeof b.message === "string" ? b.message : undefined,
		push: b.push === true,
		pr: b.pr === true,
	};
	if (!plan.branch && plan.message === undefined && !plan.push && !plan.pr)
		return c.json({ error: "nothing to do" }, 400);

	const result = await apply(cwd, plan);
	// 200 either way: a refused commit ("nothing to commit") is an answer the
	// UI shows verbatim, not a transport failure.
	return c.json(result);
});

app.post("/api/sessions/:id/thinking", async (c) => {
	const b = await readBody(c);
	const level = typeof b.level === "string" ? b.level : undefined;
	if (!level) return c.json({ error: "level required" }, 400);
	try {
		await registry.setThinkingLevel(c.req.param("id"), level);
		return c.json({ ok: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
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
app.get("/api/packages", async (c) => {
	try {
		return c.json({ piVersion: PI_VERSION ?? null, ...(await packages.view()) });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/** A mutation answers with its own outcome; the log tail is the interesting part. */
async function mutation(
	c: Context<Env>,
	work: () => Promise<{ ok: boolean; log: string; reason?: string }>,
): Promise<Response> {
	let result: { ok: boolean; log: string; reason?: string };
	try {
		result = await work();
	} catch (err) {
		// Only validation lands here, and it is the user's input that is wrong.
		return c.json(
			{ ok: false, log: "", reason: err instanceof Error ? err.message : String(err) },
			400,
		);
	}
	// A prewarmed spare booted under the OLD package set, and handing
	// that to the next `+ New` would give somebody a session that is
	// stale before they have typed anything.
	if (result.ok) registry.discardSpares();
	// 200 either way: a refused install is an answer the screen shows
	// verbatim, not a transport failure.
	return c.json(result);
}

app.post("/api/packages", async (c) => {
	const b = await readBody(c);
	const source = typeof b.source === "string" ? b.source : "";
	if (!source) return c.json({ ok: false, log: "", reason: "source required" }, 400);
	return mutation(c, () => packages.install(source));
});

app.delete("/api/packages", async (c) => {
	const b = await readBody(c);
	const source = typeof b.source === "string" ? b.source : "";
	if (!source) return c.json({ ok: false, log: "", reason: "source required" }, 400);
	return mutation(c, () => packages.remove(source));
});

app.post("/api/packages/update", async (c) => {
	const b = await readBody(c);
	const source = typeof b.source === "string" ? b.source : undefined;
	return mutation(c, () => packages.update(source));
});

/** Update the pi CLI on this machine. Never automatic. */
app.post("/api/packages/update-pi", (c) => {
	return mutation(c, () => packages.updateSelf());
});

app.get("/api/packages/search", async (c) => {
	const q = c.req.query("q") ?? "";
	return c.json(await search(q));
});

app.get("/api/packages/info", async (c) => {
	const name = c.req.query("name") ?? "";
	if (!name) return c.json({ error: "name required" }, 400);
	try {
		return c.json(await info(name));
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
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
app.get("/api/packages/project", (c) => {
	const cwd = c.req.query("cwd") || CWD;
	return c.json({ cwd, packages: packages.listProject(cwd) });
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
app.get("/api/terminals", (c) => {
	const cwd = c.req.query("cwd");
	return c.json({ terminals: terminals.list(cwd, c.req.query("fleet") === "1") });
});

app.post("/api/terminals", async (c) => {
	const b = await readBody(c);
	const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : CWD;
	const cols = Number(b.cols) || 80;
	const rows = Number(b.rows) || 24;
	const dir = typeof b.dir === "string" && b.dir ? b.dir : cwd;
	// A Fleet page shell, in the home dir; with `ssh` it starts by ssh-ing there.
	const ssh = b.ssh;
	if (ssh !== undefined && !validTarget(ssh)) return c.json({ error: "bad ssh target" }, 400);
	const fleet = b.fleet === true ? { run: ssh && `ssh ${ssh}` } : undefined;
	try {
		const term = fleet
			? terminals.create(homedir(), cols, rows, homedir(), fleet)
			: terminals.create(cwd, cols, rows, dir);
		return c.json({ id: term.id, cwd: term.cwd, running: true });
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
	}
});

app.delete("/api/terminals/:id", (c) => {
	terminals.close(c.req.param("id"));
	return c.json({ ok: true });
});

/*
 * An unknown /api path is a 404, and it has to be declared BEFORE the SPA
 * fallback below. Otherwise the catch-all answers it with index.html and a
 * 200, so a client calling an endpoint this build does not have gets HTML
 * where it expected JSON — which is exactly how a browser running new code
 * against an older server presents as a control stuck on "loading…" rather
 * than as a version mismatch.
 */
app.all("/api/*", (c) => {
	return c.json({ error: "no such endpoint" }, 404);
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
	app.get("*", (c) => {
		// Path and query exactly as sent: everything after the origin.
		const url = c.req.url;
		return c.redirect(`http://127.0.0.1:${VITE_PORT}${url.slice(url.indexOf("/", url.indexOf("//") + 2))}`, 302);
	});
} else if (existsSync(dist)) {
	app.use("*", serveStatic({ root: dist }));
	app.get("*", serveStatic({ path: resolve(dist, "index.html") }));
}

const server = createServer(getRequestListener(app.fetch));

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
	const header: Header = (name) => {
		const value = req.headers[name];
		return typeof value === "string" ? value : undefined;
	};
	if (url.pathname !== "/api/terminal/socket" || !hostAllowed(header) || !originAllowed(header)) {
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
// spawned with `--approve` so that project-local extensions load. Reach it
// through `tailscale serve`; never bind it publicly.
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

// Adoption waits on children whose watchers and polls are unref'd, and the
// listener does not exist yet: without a ref'd handle the loop drains and
// Node exits 13 on the unsettled top-level await.
const keepAlive = setInterval(() => {}, 60_000);
const adopted = await registry.adopt().finally(() => clearInterval(keepAlive));
if (adopted) console.log(`[pwi] adopted ${adopted} running pi session(s)`);

pollUsage();

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
		// Mid-turn sessions are detached, not killed: the next server adopts them.
		registry.shutdown();
		// Shells in tmux are detached for the next server to adopt; without
		// tmux each gets SIGHUP, so none is orphaned holding the project's ports.
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
