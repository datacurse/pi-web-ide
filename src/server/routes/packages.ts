import { Hono, type Context } from "hono";
import * as packages from "../packages.js";
import { info, search } from "../gallery.js";
import { readSolPi, writeSolPi } from "../solPi.js";
import { query, json, type Deps, type Env } from "../http.js";

/** pi packages on this machine, the npm gallery, and the open project's own packages. */
export function packagesRoutes({ cwd: CWD, registry }: Deps) {
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
        {
          ok: false,
          log: "",
          reason: err instanceof Error ? err.message : String(err),
        },
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

  return (
    new Hono<Env>()
      /**
       * Packages: what this machine has installed, and changing it.
       *
       * These routes are remote code execution by design — a pi package's
       * extensions are code and its skills instruct the model — which is the same
       * class of exposure as /api/terminals, already on this port. They inherit
       * that boundary and must not widen it: same loopback listener, same origin
       * guard, no new surface.
       */
      .get("/packages", async (c) => {
        try {
          const [piVersion, view] = await Promise.all([
            packages.piVersion(),
            packages.view(),
          ]);
          return c.json({ piVersion, ...view }, 200);
        } catch (err) {
          return c.json(
            { error: err instanceof Error ? err.message : String(err) },
            500,
          );
        }
      })

      .post("/packages", json<{ source: string }>(), async (c) => {
        const b = c.req.valid("json");
        const source = typeof b.source === "string" ? b.source : "";
        if (!source)
          return c.json({ ok: false, log: "", reason: "source required" }, 400);
        return mutation(c, () => packages.install(source));
      })

      .delete("/packages", json<{ source: string }>(), async (c) => {
        const b = c.req.valid("json");
        const source = typeof b.source === "string" ? b.source : "";
        if (!source)
          return c.json({ ok: false, log: "", reason: "source required" }, 400);
        return mutation(c, () => packages.remove(source));
      })

      .put(
        "/packages/enabled",
        json<{ source: string; enabled: boolean }>(),
        async (c) => {
          const b = c.req.valid("json");
          if (
            typeof b.source !== "string" ||
            !b.source.trim() ||
            typeof b.enabled !== "boolean"
          )
            return c.json(
              {
                ok: false,
                log: "",
                reason: "source and enabled boolean required",
              },
              400,
            );
          return mutation(c, () => packages.setEnabled(b.source, b.enabled));
        },
      )

      .post("/packages/update", json<{ source?: string }>(), async (c) => {
        const b = c.req.valid("json");
        const source = typeof b.source === "string" ? b.source : undefined;
        return mutation(c, () => packages.update(source));
      })

      /** Update the pi CLI on this machine. Never automatic. */
      .post("/packages/update-pi", (c) => {
        return mutation(c, () => packages.updateSelf());
      })

      .get("/packages/search", query<{ q?: string }>(), async (c) => {
        const q = c.req.query("q") ?? "";
        return c.json(await search(q), 200);
      })

      .get("/packages/info", query<{ name?: string }>(), async (c) => {
        const name = c.req.query("name") ?? "";
        if (!name) return c.json({ error: "name required" }, 400);
        try {
          return c.json(await info(name), 200);
        } catch (err) {
          return c.json(
            { error: err instanceof Error ? err.message : String(err) },
            502,
          );
        }
      })

      /**
       * The open project's own packages, read-only.
       *
       * `pi install -l` writes `.pi/settings.json`, the project commits it, and pi
       * installs anything missing at startup once the project is trusted. Git is
       * the sync for these, so this server shows them and changes nothing: a
       * second writer of a file that is in someone's repository is a merge
       * conflict waiting to be blamed on the wrong tool.
       */
      .get("/packages/project", query<{ cwd?: string }>(), (c) => {
        const cwd = c.req.query("cwd") || CWD;
        return c.json({ cwd, packages: packages.listProject(cwd) }, 200);
      })

      /** SoL-Pi's settings file. `cwd` only reports whether that project's own file replaces it. */
      .get("/packages/sol-pi", query<{ cwd?: string }>(), (c) => {
        try {
          return c.json(readSolPi(c.req.query("cwd") || CWD), 200);
        } catch (err) {
          return c.json(
            { error: err instanceof Error ? err.message : String(err) },
            500,
          );
        }
      })

      .put(
        "/packages/sol-pi",
        query<{ cwd?: string }>(),
        json<Record<string, unknown>>(),
        (c) => {
          const b = c.req.valid("json");
          if (!b || typeof b !== "object" || Array.isArray(b))
            return c.json({ error: "object required" }, 400);
          try {
            const settings = writeSolPi(b, c.req.query("cwd") || CWD);
            // A prewarmed spare started under the old settings.
            registry.discardSpares();
            return c.json(settings, 200);
          } catch (err) {
            return c.json(
              { error: err instanceof Error ? err.message : String(err) },
              400,
            );
          }
        },
      )
  );
}
