import { hc } from "hono/client";
import type { AppType } from "../server/app.js";

/**
 * The server's API, typed from its routes (server/app.ts): a renamed path,
 * body field or response field is a `pnpm typecheck` failure here rather
 * than a page that quietly breaks. The event stream, the terminal socket,
 * uploads and downloads are not JSON and stay on EventSource/fetch.
 */
export const api = hc<AppType>("/").api;
