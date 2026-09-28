/**
 * http.ts — what every route shares: the request guards, the Hono env, the
 * dependencies routes are built from, and body parsing.
 */

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { HttpBindings } from "@hono/node-server";
import type { Registry } from "./registry.js";
import type { Terminals } from "./terminals.js";

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
export const VITE_PORT = Number(process.env.PWI_VITE_PORT ?? 5480);
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
export type Header = (name: string) => string | undefined;

export function hostAllowed(header: Header): boolean {
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

export function originAllowed(header: Header): boolean {
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

/** `HttpBindings` puts Node's own req/res in `c.env`, for the routes that stream. */
export type Env = { Bindings: HttpBindings };

/** What the routes are built from: this server's settings and its two long-lived stores. */
export interface Deps {
	cwd: string;
	model: string | undefined;
	registry: Registry;
	terminals: Terminals;
	piVersion: string | undefined;
	pwiVersion: string;
	boot: string;
	degraded: () => boolean;
}

/**
 * The JSON body as an object, `{}` when there is none.
 *
 * Only `application/json` is parsed, as express.json did: a text/plain or
 * form POST is what a foreign page can send without a preflight, and it
 * stays empty here even before the origin check refuses it.
 */
export async function readBody(c: Context<Env>): Promise<Record<string, unknown>> {
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
