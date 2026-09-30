/**
 * stats.ts — usage stats, one row per answered prompt, across every project,
 * on this machine and on every machine machines.ts mirrors.
 *
 * Read from pi's session files, so terminal pi counts too.
 */

import { createReadStream, type Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { contentChars, preview, program, splitBySteps, subKey } from "../shared/toolCalls.js";
import type { StatsTurn, StatsView, ToolOutlier } from "../shared/types.js";
import { parseMetrics, type Step, type ToolMetric } from "../tool-metrics/format.js";
import { machines } from "./machines.js";
import { readWorkouts, workoutPlan } from "./workouts.js";
import { pwiExtensions } from "./pwiExtensions.js";
import { pooled, sessionFiles, userText } from "./sessions.js";
import { statePath } from "./state.js";

interface Parsed {
	size: number;
	mtimeMs: number;
	id: string;
	cwd: string;
	turns: Omit<StatsTurn, "machine">[];
}

/** How many of a turn's slowest, and of its largest, calls it keeps. */
const OUTLIERS = 3;
/** A measured bash call's time outside its commands: starting the shell, pi around it. */
const SHELL = "bash: (shell)";

/** Measured calls by id, and the background jobs each started. */
export interface Metrics {
	calls: Map<string, ToolMetric>;
	background: Map<string, ToolMetric[]>;
}

/** Same versioning as sessions.ts: pi only appends, so size + mtime is the version. */
const cache = new Map<string, Parsed>();
const metricsCache = new Map<string, { size: number; mtimeMs: number; records: ToolMetric[] }>();
/** Background-job lines at the last read; see metricsIndex. */
let jobsSeen = 0;

/**
 * Every measured call by id (tool-metrics/FORMAT.md). A session is parsed
 * after its calls' lines are written: the collector appends at the end of a
 * call, before pi appends the result to the session file. A background job's
 * line comes later, when its session may already be cached, so stats() drops
 * the cache when their count changes; they are rare.
 */
async function metricsIndex(dirs: string[]): Promise<Metrics> {
	const index: Metrics = { calls: new Map(), background: new Map() };
	const files = (
		await Promise.all(
			dirs.map((dir) =>
				readdir(dir).then(
					(names) => names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n)),
					() => [],
				),
			),
		)
	).flat();
	await pooled(
		files,
		async (file) => {
			try {
				const st = await stat(file);
				let hit = metricsCache.get(file);
				if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
					hit = { size: st.size, mtimeMs: st.mtimeMs, records: parseMetrics(await readFile(file, "utf8")) };
					metricsCache.set(file, hit);
				}
				for (const r of hit.records) {
					if (!r.type) index.calls.set(r.toolCallId, r);
					else if (r.type === "background")
						index.background.set(r.toolCallId, [...(index.background.get(r.toolCallId) ?? []), r]);
				}
			} catch {
				metricsCache.delete(file);
			}
		},
	);
	return index;
}

export async function stats(): Promise<StatsView> {
	const remote = machines();
	const metrics = await metricsIndex([statePath("tool-metrics"), ...remote.map((m) => m.metrics)]);
	const jobs = [...metrics.background.values()].reduce((n, j) => n + j.length, 0);
	if (jobs !== jobsSeen) cache.clear();
	jobsSeen = jobs;
	const sources = await Promise.all([
		sessionFiles().then((files) => files.map((file) => ({ file, machine: "" }))),
		...remote.map((m) => sessionFiles(m.root).then((files) => files.map((file) => ({ file, machine: m.name })))),
	]);
	const turns: StatsTurn[] = [];
	let sessions = 0;
	await pooled(sources.flat(), async ({ file, machine }) => {
		const p = await read(file, metrics);
		if (!p || p.turns.length === 0) return;
		sessions++;
		for (const t of p.turns) turns.push({ ...t, machine });
	});
	turns.sort((a, b) => b.start - a.start);
	const workouts = [
		...readWorkouts().map((s) => ({ ...s, machine: "" })),
		...remote.flatMap((m) => readWorkouts(m.workouts).map((s) => ({ ...s, machine: m.name }))),
	];
	return {
		turns,
		workouts,
		workoutPlan: workoutPlan(),
		workoutProfile: pwiExtensions().workoutProfile,
		sessions,
		machines: remote.map(({ name, synced, error }) => ({ name, synced, error })),
	};
}

async function read(file: string, metrics: Metrics): Promise<Parsed | undefined> {
	let st: Stats;
	try {
		st = await stat(file);
	} catch {
		cache.delete(file);
		return undefined;
	}
	const hit = cache.get(file);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
	const parsed = await parse(file, st, metrics);
	if (parsed) cache.set(file, parsed);
	return parsed;
}

/** Exported for the tests. */
export async function parseLines(
	lines: AsyncIterable<string> | Iterable<string>,
	metrics: Metrics = { calls: new Map(), background: new Map() },
): Promise<Omit<Parsed, "size" | "mtimeMs">> {
	const out: Omit<Parsed, "size" | "mtimeMs"> = { id: "", cwd: "", turns: [] };
	let turn: Omit<StatsTurn, "machine"> | undefined;
	let end = 0;
	/**
	 * This turn's calls, sizes in chars until close. Timed by the collector
	 * when it ran (`measured`), else `sent`/`batch` estimate the wait.
	 */
	let calls: (ToolOutlier & {
		sent: number;
		batch: number;
		hookMs: number;
		measured: boolean;
		steps?: Step[];
		jobs?: ToolMetric[];
	})[] = [];
	const pending = new Map<string, (typeof calls)[number]>();
	const close = () => {
		if (turn && end > turn.start && turn.outcome) {
			const costs = turn.costs;
			const add = (key: string, calls: number, tokens: number, ms: number, hookMs: number, measured: number) => {
				const cost = (costs[key] ??= { calls: 0, tokens: 0, ms: 0, hookMs: 0, measured: 0 });
				cost.calls += calls;
				cost.tokens += tokens;
				cost.ms += ms;
				cost.hookMs += hookMs;
				cost.measured += measured;
			};
			/** What the outlier lists rank: calls, and a measured bash call's commands in its place. */
			const units: ToolOutlier[] = [];
			for (const c of calls) {
				c.tokens = Math.ceil(c.tokens / 4);
				if (!c.steps?.length) {
					add(c.key, 1, c.tokens, c.ms, c.hookMs, c.measured ? 1 : 0);
					units.push(c);
					continue;
				}
				const shares = splitBySteps(c.tokens, c.steps);
				let inSteps = 0;
				c.steps.forEach((s, i) => {
					const key = `bash: ${program(s.text)}`;
					const tokens = Math.round(shares[i] ?? 0);
					const runs = s.runs ?? 1;
					add(key, runs, tokens, s.ms, 0, runs);
					units.push({ key, preview: preview("bash", { command: s.text }), tokens, ms: s.ms });
					inSteps += s.ms;
				});
				add(SHELL, 1, 0, Math.max(0, c.ms - inSteps), c.hookMs, 1);
				for (const j of c.jobs ?? [])
					turn.background.push({
						text: (j.step !== undefined ? c.steps[j.step]?.text : undefined) ?? c.preview,
						ms: j.ms,
					});
			}
			const by = (k: "ms" | "tokens") => [...units].sort((a, b) => b[k] - a[k]).slice(0, OUTLIERS);
			turn.outliers = [...new Set([...by("ms"), ...by("tokens")])].map(({ key, preview, tokens, ms }) => ({
				key,
				preview,
				tokens,
				ms,
			}));
			out.turns.push({ ...turn, ms: end - turn.start });
		}
		turn = undefined;
		calls = [];
		pending.clear();
	};
	for await (const line of lines) {
		if (!line) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// The last line of a live session is often half-written.
			continue;
		}
		if (entry?.type === "session") {
			if (typeof entry.id === "string") out.id = entry.id;
			if (typeof entry.cwd === "string") out.cwd = entry.cwd;
			continue;
		}
		if (entry?.type !== "message") continue;
		const m = entry.message as Record<string, unknown> | undefined;
		if (!m) continue;
		const at = Date.parse(String(entry.timestamp));
		if (m.role === "user") {
			close();
			const start = typeof m.timestamp === "number" ? m.timestamp : at;
			if (Number.isNaN(start)) continue;
			turn = {
				session: out.id,
				cwd: out.cwd,
				start,
				ms: 0,
				model: "",
				prompt: userText(m),
				tools: {},
				costs: {},
				outliers: [],
				background: [],
				outputTokens: 0,
				cost: 0,
				outcome: "",
			};
			end = 0;
			continue;
		}
		if (!turn) continue;
		if (!Number.isNaN(at)) end = at;
		if (m.role === "toolResult") {
			const c = pending.get(String(m.toolCallId));
			const done = typeof m.timestamp === "number" ? m.timestamp : at;
			if (!c) continue;
			pending.delete(String(m.toolCallId));
			c.tokens += contentChars(m.content);
			const exact = metrics.calls.get(String(m.toolCallId));
			if (exact) {
				c.ms = exact.ms;
				c.hookMs = exact.hookMs ?? 0;
				c.measured = true;
				c.steps = exact.steps;
				c.jobs = metrics.background.get(String(m.toolCallId));
			} else if (done > c.sent) c.ms = (done - c.sent) / c.batch;
			continue;
		}
		if (m.role !== "assistant") continue;
		if (typeof m.model === "string") turn.model = m.model;
		if (typeof m.stopReason === "string") turn.outcome = m.stopReason;
		const usage = m.usage as { output?: unknown; cost?: { total?: unknown } } | undefined;
		if (typeof usage?.output === "number") turn.outputTokens += usage.output;
		if (typeof usage?.cost?.total === "number") turn.cost += usage.cost.total;
		if (Array.isArray(m.content)) {
			const batch = (m.content as { type?: unknown; name?: unknown; id?: unknown; arguments?: unknown }[]).filter(
				(b): b is { type: "toolCall"; name: string; id?: unknown; arguments?: unknown } =>
					b?.type === "toolCall" && typeof b.name === "string",
			);
			for (const b of batch) {
				turn.tools[b.name] = (turn.tools[b.name] ?? 0) + 1;
				const sub = b.name === "bash" ? subKey(b.name, b.arguments) : undefined;
				const c = {
					key: sub ? `bash: ${sub}` : b.name,
					preview: preview(b.name, b.arguments),
					tokens: b.name.length + JSON.stringify(b.arguments ?? {}).length,
					ms: 0,
					// The entry is written when the message ends, which is when its tools start.
					sent: at,
					batch: batch.length,
					hookMs: 0,
					measured: false,
				};
				calls.push(c);
				if (typeof b.id === "string") pending.set(b.id, c);
			}
		}
	}
	close();
	return out;
}

async function parse(file: string, st: Stats, metrics: Metrics): Promise<Parsed | undefined> {
	const stream = createReadStream(file, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		return { size: st.size, mtimeMs: st.mtimeMs, ...(await parseLines(rl, metrics)) };
	} catch {
		return undefined;
	} finally {
		rl.close();
		stream.destroy();
	}
}
