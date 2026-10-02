import {
  DetailedError,
  hc,
  parseResponse,
  type ClientResponse,
} from "hono/client";
import type { AppType } from "../server/app.js";

/**
 * The server's API, typed from its routes (server/app.ts): a renamed path,
 * body field or response field is a `pnpm typecheck` failure here rather
 * than a page that quietly breaks. The event stream, the terminal socket,
 * uploads and downloads are not JSON and stay on EventSource/fetch.
 */
export const api = hc<AppType>("/").api;

/**
 * A successful response's body, typed by its route. Any other status throws
 * the server's own `{ error }` message, which is what the UI shows, falling
 * back to the status code.
 */
export async function unwrap<R extends ClientResponse<unknown>>(
  request: R | Promise<R>,
) {
  try {
    return await parseResponse(request);
  } catch (err) {
    if (!(err instanceof DetailedError)) throw err;
    const data: unknown = err.detail?.data;
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : String(err.statusCode ?? err.message);
    throw new Error(message);
  }
}
