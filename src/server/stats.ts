/**
 * stats.ts — usage stats, one row per answered prompt, across every project,
 * on this machine and on every machine machines.ts mirrors.
 *
 * Read from pi's session files, so terminal pi counts too.
 */

import { createReadStream, type Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { StatsTurn, StatsView } from "../shared/types.js";
import { machines } from "./machines.js";
import { pooled, sessionFiles, userText } from "./sessions.js";

interface Parsed {
	size: number;
	mtimeMs: number;
	id: string;
	cwd: string;
	turns: Omit<StatsTurn, "machine">[];
}

/** Same versioning as sessions.ts: pi only appends, so size + mtime is the version. */
const cache = new Map<string, Parsed>();

export async function stats(): Promise<StatsView> {
	const remote = machines();
	const sources = await Promise.all([
		sessionFiles().then((files) => files.map((file) => ({ file, machine: "" }))),
		...remote.map((m) => sessionFiles(m.root).then((files) => files.map((file) => ({ file, machine: m.name })))),
	]);
	const turns: StatsTurn[] = [];
	let sessions = 0;
	await pooled(sources.flat(), async ({ file, machine }) => {
		const p = await read(file);
		if (!p || p.turns.length === 0) return;
		sessions++;
		for (const t of p.turns) turns.push({ ...t, machine });
	});
	turns.sort((a, b) => b.start - a.start);
	return { turns, sessions, machines: remote.map(({ name, synced, error }) => ({ name, synced, error })) };
}

async function read(file: string): Promise<Parsed | undefined> {
	let st: Stats;
	try {
		st = await stat(file);
	} catch {
		cache.delete(file);
		return undefined;
	}
	const hit = cache.get(file);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
	const parsed = await parse(file, st);
	if (parsed) cache.set(file, parsed);
	return parsed;
}

/** Exported for the tests. */
export async function parseLines(
	lines: AsyncIterable<string> | Iterable<string>,
): Promise<Omit<Parsed, "size" | "mtimeMs">> {
	const out: Omit<Parsed, "size" | "mtimeMs"> = { id: "", cwd: "", turns: [] };
	let turn: Omit<StatsTurn, "machine"> | undefined;
	let end = 0;
	const close = () => {
		if (turn && end > turn.start && turn.outcome) out.turns.push({ ...turn, ms: end - turn.start });
		turn = undefined;
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
				outputTokens: 0,
				cost: 0,
				outcome: "",
			};
			end = 0;
			continue;
		}
		if (!turn) continue;
		if (!Number.isNaN(at)) end = at;
		if (m.role !== "assistant") continue;
		if (typeof m.model === "string") turn.model = m.model;
		if (typeof m.stopReason === "string") turn.outcome = m.stopReason;
		const usage = m.usage as { output?: unknown; cost?: { total?: unknown } } | undefined;
		if (typeof usage?.output === "number") turn.outputTokens += usage.output;
		if (typeof usage?.cost?.total === "number") turn.cost += usage.cost.total;
		if (Array.isArray(m.content)) {
			for (const b of m.content as { type?: unknown; name?: unknown }[]) {
				if (b?.type === "toolCall" && typeof b.name === "string")
					turn.tools[b.name] = (turn.tools[b.name] ?? 0) + 1;
			}
		}
	}
	close();
	return out;
}

async function parse(file: string, st: Stats): Promise<Parsed | undefined> {
	const stream = createReadStream(file, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		return { size: st.size, mtimeMs: st.mtimeMs, ...(await parseLines(rl)) };
	} catch {
		return undefined;
	} finally {
		rl.close();
		stream.destroy();
	}
}
