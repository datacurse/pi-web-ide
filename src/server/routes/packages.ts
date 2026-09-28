import { Hono, type Context } from "hono";
import * as packages from "../packages.js";
import { info, search } from "../gallery.js";
import { readBody, type Deps, type Env } from "../http.js";

/** pi packages on this machine, the npm gallery, and the open project's own packages. */
export function packagesRoutes({ cwd: CWD, registry, piVersion: PI_VERSION }: Deps) {
	const routes = new Hono<Env>();

	/**
	 * Packages: what this machine has installed, and changing it.
	 *
	 * These routes are remote code execution by design — a pi package's
	 * extensions are code and its skills instruct the model — which is the same
	 * class of exposure as /api/terminals, already on this port. They inherit
	 * that boundary and must not widen it: same loopback listener, same origin
	 * guard, no new surface.
	 */
	routes.get("/packages", async (c) => {
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

	routes.post("/packages", async (c) => {
		const b = await readBody(c);
		const source = typeof b.source === "string" ? b.source : "";
		if (!source) return c.json({ ok: false, log: "", reason: "source required" }, 400);
		return mutation(c, () => packages.install(source));
	});

	routes.delete("/packages", async (c) => {
		const b = await readBody(c);
		const source = typeof b.source === "string" ? b.source : "";
		if (!source) return c.json({ ok: false, log: "", reason: "source required" }, 400);
		return mutation(c, () => packages.remove(source));
	});

	routes.post("/packages/update", async (c) => {
		const b = await readBody(c);
		const source = typeof b.source === "string" ? b.source : undefined;
		return mutation(c, () => packages.update(source));
	});

	/** Update the pi CLI on this machine. Never automatic. */
	routes.post("/packages/update-pi", (c) => {
		return mutation(c, () => packages.updateSelf());
	});

	routes.get("/packages/search", async (c) => {
		const q = c.req.query("q") ?? "";
		return c.json(await search(q));
	});

	routes.get("/packages/info", async (c) => {
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
	routes.get("/packages/project", (c) => {
		const cwd = c.req.query("cwd") || CWD;
		return c.json({ cwd, packages: packages.listProject(cwd) });
	});

	return routes;
}
