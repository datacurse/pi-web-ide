/**
 * index.ts — the process: settings, crash policy, serving the API (app.ts)
 * and the built client, the terminal WebSocket, port takeover, shutdown.
 */

import { createApp } from "./app.js";
import { hostAllowed, originAllowed, VITE_PORT, type Header } from "./http.js";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { pollUsage } from "./usage.js";
import { Terminals } from "./terminals.js";
import { Registry } from "./registry.js";
import { PI_BIN } from "./agent.js";
import { claimPort } from "./takeover.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const PORT = Number(process.env.PWI_PORT ?? 8890);
const CWD = resolve(process.env.PWI_CWD ?? process.argv[2] ?? process.cwd());
/** "provider/id". Pi's own default may select a provider your plan blocks. */
const MODEL = process.env.PWI_MODEL;

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
const app = createApp({
	cwd: CWD,
	model: MODEL,
	registry,
	terminals,
	piVersion: PI_VERSION,
	pwiVersion: PWI_VERSION,
	boot: BOOT,
	degraded: () => degraded,
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
