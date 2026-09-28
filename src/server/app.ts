/**
 * app.ts — the HTTP API as one Hono app, with no side effects of its own:
 * index.ts serves it, and tests call it in-process with `app.request()`.
 *
 * SSE for events, POST for commands. SSE rather than WebSocket on purpose:
 * this is one-directional streaming plus discrete commands. The browser gives
 * us reconnect semantics for free, and prompt/abort are plain POSTs. A
 * WebSocket would buy nothing and cost us a framing/reconnect/ack protocol to
 * write and debug. The terminal is the exception, in index.ts.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { hostAllowed, originAllowed, type Deps, type Env, type Header } from "./http.js";
import { systemRoutes } from "./routes/system.js";
import { sessionsRoutes } from "./routes/sessions.js";
import { filesRoutes } from "./routes/files.js";
import { gitRoutes } from "./routes/git.js";
import { packagesRoutes } from "./routes/packages.js";
import { terminalsRoutes } from "./routes/terminals.js";

export function createApp(deps: Deps) {
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

	// Chained, not looped: the chain's type is AppType, which is what gives
	// the browser's `hc` client every route's path, body and response.
	const api = app
		.route("/api", systemRoutes(deps))
		.route("/api", sessionsRoutes(deps))
		.route("/api", filesRoutes(deps))
		.route("/api", gitRoutes(deps))
		.route("/api", packagesRoutes(deps))
		.route("/api", terminalsRoutes(deps));

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

	return api;
}

export type AppType = ReturnType<typeof createApp>;
