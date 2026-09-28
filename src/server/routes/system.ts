import { Hono } from "hono";
import { listModels, readSettings, setDefaultModel, setDefaultThinkingLevel } from "../models.js";
import { stats } from "../stats.js";
import { syncMachines } from "../machines.js";
import { fetchUsage, readHistory } from "../usage.js";
import { fleet, startPwi, validTarget } from "../fleet.js";
import {
	addFavorite,
	addProject,
	browse,
	listFavorites,
	listProjects,
	removeFavorite,
	removeProject,
} from "../projects.js";
import { readPersonality, writePersonality, writeRemind } from "../personality.js";
import { PRODUCT } from "../../shared/types.js";
import { readBody, type Deps, type Env } from "../http.js";

/** Machine-level routes: health, models, usage, stats, fleet, projects, favourites, personality. */
export function systemRoutes({ cwd: CWD, model: MODEL, registry, piVersion: PI_VERSION, pwiVersion: PWI_VERSION, boot: BOOT, degraded }: Deps) {
	const routes = new Hono<Env>();

	routes.get("/health", (c) => {
		// `pid` is what lets the NEXT pwi take this port without a /proc scan;
		// see takeover.ts, which also checks `product` before killing anything.
		return c.json({
			ok: true,
			product: PRODUCT,
			cwd: CWD,
			model: MODEL ?? null,
			degraded: degraded(),
			pid: process.pid,
			boot: BOOT,
			pwiVersion: PWI_VERSION,
			piVersion: PI_VERSION ?? null,
		});
	});

	routes.get("/models", async (c) => {
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
	routes.get("/usage", async (c) => {
		const r = await fetchUsage();
		if ("error" in r) return c.json({ error: r.error }, 502);
		return c.json({ ...r.body, history: readHistory() });
	});

	/** `?sync=1` first brings other machines' mirrors up to date (throttled); `?sync=force` always does. */
	routes.get("/stats", async (c) => {
		try {
			if (c.req.query("sync")) await syncMachines(c.req.query("sync") === "force");
			return c.json(await stats());
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
		}
	});

	/** Every tailnet machine with its pwi link and state (server/fleet.ts). */
	routes.get("/fleet", async (c) => {
		try {
			return c.json({ machines: await fleet() });
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
		}
	});

	/** Start pwi on another machine over ssh and serve it on the tailnet. */
	routes.post("/fleet/start", async (c) => {
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
	routes.post("/default-model", async (c) => {
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
	routes.post("/default-thinking", async (c) => {
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
	routes.get("/projects", (c) => {
		return c.json({ projects: listProjects(CWD), active: CWD });
	});

	routes.post("/projects", async (c) => {
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

	routes.delete("/projects", async (c) => {
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
	routes.get("/browse", (c) => {
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
	routes.get("/favorites", (c) => {
		return c.json({ favorites: listFavorites() });
	});

	routes.post("/favorites", async (c) => {
		const b = await readBody(c);
		const path = typeof b.path === "string" ? b.path : "";
		if (!path.trim()) return c.json({ error: "path required" }, 400);
		try {
			return c.json({ favorites: addFavorite(path) });
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
		}
	});

	routes.delete("/favorites", async (c) => {
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
	routes.get("/personality", (c) => {
		return c.json(readPersonality());
	});

	/** The "Repeat before every reply" toggle. Applies to sessions started after it. */
	routes.put("/personality/remind", async (c) => {
		const b = await readBody(c);
		if (typeof b.remind !== "boolean") {
			return c.json({ error: "remind must be a boolean" }, 400);
		}
		return c.json(writeRemind(b.remind));
	});

	routes.put("/personality", async (c) => {
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

	return routes;
}
