import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type { Registry } from "./registry.js";
import { safePath } from "./files.js";
import { watchFiles } from "./fileWatch.js";

/** Live updates use upgraded connections, not the browser's HTTP/1 connection pool. */
export function attachEvents(
  ws: WebSocket,
  req: IncomingMessage,
  cwd: string,
  registry: Registry,
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (data: string) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  };
  let detach: () => void;
  if (url.pathname === "/api/files/watch") {
    try {
      const root = safePath(cwd, url.searchParams.get("root") ?? "");
      detach = watchFiles(cwd, root, url.searchParams.getAll("dir"), () =>
        send("change"),
      );
    } catch {
      ws.close(4400, "invalid root");
      return;
    }
    // A reconnect may have missed changes while offline.
    send("change");
  } else {
    const id = url.pathname.split("/")[3]!;
    if (!registry.get(id)) {
      ws.close(4404, "no such session");
      return;
    }
    registry.clearDeadError(id);
    detach = registry.attach(id, (event) => send(JSON.stringify(event)));
  }

  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 15_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    detach();
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}
