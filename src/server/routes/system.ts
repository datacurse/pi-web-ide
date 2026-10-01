import { Hono } from "hono";
import { listModels, readSettings, setDefaultModel, setDefaultThinkingLevel } from "../models.js";
import { stats } from "../stats.js";
import { syncMachines } from "../machines.js";
import { defaultUsageProvider, fetchUsage, readHistory, usageProviders } from "../usage.js";
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
import {
	pwiExtensions,
	writePwiExtension,
	writeWorkoutOff,
	writeWorkoutProfile,
	writeWorkoutSchedule,
} from "../pwiExtensions.js";
import { addWorkout, isWorkoutKind, skipWorkout, snoozeWorkout, workoutPlan } from "../workouts.js";
import { PRODUCT, type WorkoutProfile } from "../../shared/types.js";
import { query, json, type Deps, type Env } from "../http.js";
import { automaticModels, setAutomaticModel, setAutoCompaction } from "../automaticModels.js";
import { autoCompactionEnabled } from "../automaticModelConfig.js";
import { agentInstructions, switchAgentInstructions } from "../agentInstructions.js";
import { safePath } from "../files.js";

/** Machine-level routes: health, models, usage, stats, fleet, projects, favourites, personality. */
export function systemRoutes({ cwd: CWD, model: MODEL, registry, piVersion: PI_VERSION, pwiVersion: PWI_VERSION, boot: BOOT, degraded }: Deps) {
	return new Hono<Env>()
		.get("/health", (c) => {
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
			}, 200);
		})

		.get("/models", async (c) => {
			try {
				const { defaultProvider: p, defaultModel: m, defaultThinkingLevel: t } = readSettings();
				return c.json({
					models: await listModels(),
					default: p && m ? `${p}/${m}` : null,
					defaultThinking: typeof t === "string" ? t : null,
				}, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		.get("/agent-instructions", query<{ cwd?: string }>(), async (c) => {
			try {
				const cwd = safePath(CWD, c.req.query("cwd") || CWD);
				return c.json(await agentInstructions(cwd), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})
		.post("/agent-instructions", query<{ cwd?: string }>(), json<{ scope: "global" | "local"; version: string | null; expected: string | null }>(), async (c) => {
			try {
				const cwd = safePath(CWD, c.req.query("cwd") || CWD);
				const { scope, version, expected } = c.req.valid("json");
				switchAgentInstructions(cwd, scope, version, expected);
				registry.discardSpares();
				return c.json(await agentInstructions(cwd), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.get("/automatic-models", query<{ cwd?: string }>(), async (c) => {
			try {
				const cwd = c.req.query("cwd") || CWD;
				return c.json({ models: await listModels(), selected: automaticModels(cwd), autoCompaction: autoCompactionEnabled() }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		.put("/automatic-models", query<{ cwd?: string }>(), json<{ action: string; model: string }>(), async (c) => {
			try {
				const { action, model } = c.req.valid("json");
				const cwd = c.req.query("cwd") || CWD;
				await setAutomaticModel(action, model, cwd);
				registry.discardSpares();
				return c.json({ selected: automaticModels(cwd) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.put("/auto-compaction", json<{ enabled: boolean }>(), async (c) => {
			try {
				const { enabled } = c.req.valid("json");
				setAutoCompaction(enabled);
				registry.discardSpares();
				await registry.setAutoCompaction(enabled);
				return c.json({ autoCompaction: autoCompactionEnabled() }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.get("/usage", query<{ provider?: string }>(), async (c) => {
			const provider = c.req.query("provider") || defaultUsageProvider();
			const providers = usageProviders();
			const r = await fetchUsage(provider);
			if ("error" in r) return c.json({ error: r.error, provider, providers }, 502);
			return c.json({ ...r.body, providers, history: readHistory(provider) }, 200);
		})

		/** `?sync=1` first brings other machines' mirrors up to date (throttled); `?sync=force` always does. */
		.get("/stats", query<{ sync?: string }>(), async (c) => {
			try {
				if (c.req.query("sync")) await syncMachines(c.req.query("sync") === "force");
				return c.json(await stats(), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		})

		/** Every tailnet machine with its pwi link and state (server/fleet.ts). */
		.get("/fleet", async (c) => {
			try {
				return c.json({ machines: await fleet() }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
			}
		})

		/** Start pwi on another machine over ssh and serve it on the tailnet. */
		.post("/fleet/start", json<{ ssh: string }>(), async (c) => {
			const b = c.req.valid("json");
			const target = b.ssh;
			if (!validTarget(target)) return c.json({ error: "bad ssh target" }, 400);
			try {
				await startPwi(target);
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
			}
		})

		/** Persist "provider/id" as pi's own startup default, for future sessions; `null` clears it. */
		.post("/default-model", json<{ model: string | null }>(), async (c) => {
			const b = c.req.valid("json");
			const model = b.model;
			if (model !== null && (typeof model !== "string" || !model)) {
				return c.json({ error: "model required" }, 400);
			}
			try {
				await setDefaultModel(model);
				// A prewarmed session booted under the OLD default, and handing that to
				// the next `+ New` would quietly ignore the change the user just made.
				registry.discardSpares();
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/** Persist pi's startup reasoning level for future sessions; `null` clears it. */
		.post("/default-thinking", json<{ level: string | null }>(), async (c) => {
			const b = c.req.valid("json");
			const level = b.level;
			if (level !== null && (typeof level !== "string" || !level)) {
				return c.json({ error: "level required" }, 400);
			}
			try {
				setDefaultThinkingLevel(level);
				registry.discardSpares(); // same reason as /api/default-model
				return c.json({ ok: true }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * Projects: the directories whose sessions we show. A project IS a cwd — pi
		 * already partitions sessions by working directory, so this list is the only
		 * new state in the feature.
		 */
		.get("/projects", (c) => {
			return c.json({ projects: listProjects(CWD), active: CWD }, 200);
		})

		.post("/projects", json<{ path: string }>(), async (c) => {
			const b = c.req.valid("json");
			const path = typeof b.path === "string" ? b.path : "";
			if (!path.trim()) return c.json({ error: "path required" }, 400);
			try {
				// addProject validates existence + directory-ness: the path comes from the
				// browser, and a typo would otherwise mint a session dir for a ghost cwd.
				return c.json({ projects: addProject(CWD, path) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.delete("/projects", json<{ path: string }>(), async (c) => {
			const b = c.req.valid("json");
			const path = typeof b.path === "string" ? b.path : "";
			return c.json({ projects: removeProject(CWD, path) }, 200);
		})

		/**
		 * Subdirectories of one directory, for the project picker.
		 *
		 * A GET with the path in the query string, so browsing is a plain navigation
		 * the browser can cache and retry: this reads the filesystem and changes
		 * nothing. Unreadable or missing paths are a 400 with the OS message (EACCES,
		 * ENOENT) — the picker shows it and stays where it was, which is the only
		 * useful answer to "that folder is not yours to read".
		 */
		.get("/browse", query<{ path?: string }>(), (c) => {
			const path = c.req.query("path") ?? "";
			try {
				return c.json(browse(path), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		/**
		 * Favourites: directories pinned in the picker, as one-click starting points.
		 *
		 * Server-side state rather than a browser preference, because these are paths
		 * on the machine pwi runs on — a per-origin copy would follow the browser to
		 * a machine where the paths mean nothing.
		 */
		.get("/favorites", (c) => {
			return c.json({ favorites: listFavorites() }, 200);
		})

		.post("/favorites", json<{ path: string }>(), async (c) => {
			const b = c.req.valid("json");
			const path = typeof b.path === "string" ? b.path : "";
			if (!path.trim()) return c.json({ error: "path required" }, 400);
			try {
				return c.json({ favorites: addFavorite(path) }, 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		})

		.delete("/favorites", json<{ path: string }>(), async (c) => {
			const b = c.req.valid("json");
			const path = typeof b.path === "string" ? b.path : "";
			return c.json({ favorites: removeFavorite(path) }, 200);
		})

		/**
		 * Personality: extra system-prompt text this server owns, at
		 * `<state dir>/personality.md`.
		 *
		 * pi has no personality file of its own; the text is passed to each child as
		 * `--append-system-prompt`. A new session picks up a change because each
		 * session is its own pi child; sessions already running keep the prompt they
		 * were started with.
		 */
		.get("/personality", (c) => {
			return c.json(readPersonality(), 200);
		})

		/** The switchable extensions pwi loads into its sessions, for the Packages page. */
		.get("/pwi-extensions", (c) => c.json(pwiExtensions(), 200))

		/** The tool-metrics collector. Applies to sessions started after it. */
		.put("/pwi-extensions/tool-metrics", json<{ on: boolean }>(), async (c) => {
			const b = c.req.valid("json");
			if (typeof b.on !== "boolean") return c.json({ error: "on must be a boolean" }, 400);
			return c.json(writePwiExtension("toolMetrics", b.on), 200);
		})

		/** The sets coming up and each muscle group's load, for the corner card and Stats (server/workouts.ts). */
		.get("/workouts/plan", (c) => c.json(workoutPlan(), 200))

		/** Skip the set that is due; the next one counts from now. */
		.post("/workouts/skip", (c) => {
			skipWorkout();
			return c.json(workoutPlan(), 200);
		})

		.post("/workouts/snooze", json<{ minutes: number }>(), async (c) => {
			const { minutes } = c.req.valid("json");
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
				return c.json({ error: "minutes must be a whole number from 1 to 240" }, 400);
			}
			snoozeWorkout(minutes);
			return c.json(workoutPlan(), 200);
		})

		/** How often a set is due and in which hours. */
		.put("/pwi-extensions/workout-schedule", json<{ every: number; from: number; to: number }>(), async (c) => {
			const next = writeWorkoutSchedule(c.req.valid("json"));
			if (!next) return c.json({ error: "every 1–240 minutes, from < to in whole hours 0–24" }, 400);
			return c.json(next, 200);
		})

		/** Log a set done for the workout gate; Stats reads them with /stats. */
		.post("/workouts", json<{ kind: string }>(), async (c) => {
			const b = c.req.valid("json");
			if (!isWorkoutKind(b.kind)) return c.json({ error: "unknown exercise" }, 400);
			return c.json(addWorkout(b.kind), 200);
		})

		/** The workout gate. The browser reads it on each send. */
		.put("/pwi-extensions/workout", json<{ on: boolean }>(), async (c) => {
			const b = c.req.valid("json");
			if (typeof b.on !== "boolean") return c.json({ error: "on must be a boolean" }, 400);
			return c.json(writePwiExtension("workout", b.on), 200);
		})

		/** The body calorie estimates use; null clears it. */
		.put("/pwi-extensions/workout-profile", json<{ profile: WorkoutProfile | null }>(), async (c) => {
			const next = writeWorkoutProfile(c.req.valid("json").profile);
			if (!next) return c.json({ error: "sex male or female, age 10–120, height 100–250 cm, weight 30–300 kg" }, 400);
			return c.json(next, 200);
		})

		/** Which exercises the workout dialog may pick; at least one stays on. */
		.put("/pwi-extensions/workout-exercises", json<{ off: string[] }>(), async (c) => {
			const next = writeWorkoutOff(c.req.valid("json").off);
			if (!next) return c.json({ error: "off must list known exercises and leave one on" }, 400);
			return c.json(next, 200);
		})

		/** The "Repeat before every reply" toggle. Applies to sessions started after it. */
		.put("/personality/remind", json<{ remind: boolean }>(), async (c) => {
			const b = c.req.valid("json");
			if (typeof b.remind !== "boolean") {
				return c.json({ error: "remind must be a boolean" }, 400);
			}
			return c.json(writeRemind(b.remind), 200);
		})

		.put("/personality", json<{ content: string }>(), async (c) => {
			const b = c.req.valid("json");
			if (typeof b.content !== "string") {
				return c.json({ error: "content required" }, 400);
			}
			try {
				return c.json(writePersonality(b.content), 200);
			} catch (err) {
				return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
			}
		});
}
