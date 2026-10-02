import { Hono } from "hono";
import { homedir } from "node:os";
import { validTarget } from "../fleet.js";
import { query, json, type Deps, type Env } from "../http.js";

/** Terminals over HTTP: create, list, close. The shell itself is the WebSocket in index.ts. */
export function terminalsRoutes({ cwd: CWD, terminals }: Deps) {
  return (
    new Hono<Env>()
      /**
       * Terminals: HTTP creates, lists and kills them; the SHELL itself talks over
       * the WebSocket below, because a terminal is bidirectional and SSE is not.
       * Everything else in this app is request/response or server-push, so this is
       * the one place that needed a second protocol.
       *
       * The list is what lets a reloaded client recover: it persists a layout of
       * ids and this says which of them still exist.
       */
      .get("/terminals", query<{ cwd?: string; fleet?: string }>(), (c) => {
        const cwd = c.req.query("cwd");
        return c.json(
          { terminals: terminals.list(cwd, c.req.query("fleet") === "1") },
          200,
        );
      })

      .post(
        "/terminals",
        json<{
          cwd?: string;
          cols?: number;
          rows?: number;
          dir?: string;
          ssh?: string;
          fleet?: boolean;
        }>(),
        async (c) => {
          const b = c.req.valid("json");
          const cwd = typeof b.cwd === "string" && b.cwd ? b.cwd : CWD;
          const cols = Number(b.cols) || 80;
          const rows = Number(b.rows) || 24;
          const dir = typeof b.dir === "string" && b.dir ? b.dir : cwd;
          // A Fleet page shell, in the home dir; with `ssh` it starts by ssh-ing there.
          const ssh = b.ssh;
          if (ssh !== undefined && !validTarget(ssh))
            return c.json({ error: "bad ssh target" }, 400);
          const fleet =
            b.fleet === true ? { run: ssh && `ssh ${ssh}` } : undefined;
          try {
            const term = fleet
              ? terminals.create(homedir(), cols, rows, homedir(), fleet)
              : terminals.create(cwd, cols, rows, dir);
            return c.json({ id: term.id, cwd: term.cwd, running: true }, 200);
          } catch (err) {
            return c.json(
              { error: err instanceof Error ? err.message : String(err) },
              400,
            );
          }
        },
      )

      .delete("/terminals/:id", async (c) => {
        await terminals.close(c.req.param("id"));
        return c.json({ ok: true }, 200);
      })
  );
}
