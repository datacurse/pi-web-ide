import { supportsFastMode } from "../shared/fastMode.js";
import { t } from "./i18n.js";
import type { StatsTurn } from "../shared/types.js";
import { providerLabel, type UsageLimit } from "../shared/usage.js";

export function usageLimitLabel(l: UsageLimit): string {
	if (l.windowMs === 5 * 3_600_000) return t("Current session");
	if (l.windowMs === 7 * 86_400_000) return t("This week");
	if (l.windowMs) return t("{span} window", { span: span(l.windowMs) });
	if (l.kind === "session" || l.kind === "openai_primary_window") return t("Current session");
	if (l.kind === "weekly_all" || l.kind === "openai_secondary_window") return t("This week");
	const model = l.scope?.model?.display_name;
	return model ? t("{model} this week", { model }) : l.kind.replace(/_/g, " ");
}

export function turnProvider(turn: StatsTurn): string {
	return turn.mixedModels ? "@mixed" : turn.provider || "@unknown";
}

export function modelKey(turn: StatsTurn): string {
	return turn.mixedModels ? "@mixed" : `${turnProvider(turn)}/${turn.model || "?"}`;
}

export function statsProviderLabel(provider: string): string {
	return provider === "@mixed" ? t("Mixed models") : provider === "@unknown" ? t("Unknown provider") : providerLabel(provider);
}

export function modelLabel(turn: StatsTurn): string {
	return turn.mixedModels ? t("Mixed models") : `${statsProviderLabel(turnProvider(turn))} / ${turn.model || "?"}`;
}

export function turnMode(turn: StatsTurn): "fast" | "standard" | "unknown" | "mixed" {
	if (turn.mixedFastMode) return "mixed";
	if (turn.fastMode === true) return "fast";
	if (turn.fastMode === false) return "standard";
	return !turn.mixedModels && turn.provider && turn.model && !supportsFastMode(`${turn.provider}/${turn.model}`)
		? "standard" : "unknown";
}

export function turnModeLabel(turn: StatsTurn): string {
	switch (turnMode(turn)) {
		case "fast": return t("Fast mode");
		case "standard": return t("Standard mode");
		case "mixed": return t("Mixed modes");
		case "unknown": return t("Unknown mode");
	}
}

export function filterTurns(turns: StatsTurn[], provider: string, model: string, mode = ""): StatsTurn[] {
	return turns.filter((turn) => (!provider || turnProvider(turn) === provider) && (!model || modelKey(turn) === model)
		&& (!mode || turnMode(turn) === mode));
}

export function tokensPerSecond(turn: StatsTurn): number | undefined {
	return turn.generationMs && Number.isFinite(turn.generationMs) && turn.generationMs > 0
		&& Number.isFinite(turn.outputTokens) && turn.outputTokens > 0
		? turn.outputTokens * 1000 / turn.generationMs : undefined;
}

export function modelComparisons(turns: StatsTurn[]) {
	const groups = new Map<string, StatsTurn[]>();
	for (const turn of turns) {
		const key = `${modelKey(turn)}:${turnMode(turn)}`;
		const group = groups.get(key) ?? [];
		group.push(turn);
		groups.set(key, group);
	}
	return [...groups].map(([key, rows]) => {
		const times = rows.map((turn) => turn.ms).sort((a, b) => a - b);
		const measured = rows.filter((turn) => tokensPerSecond(turn) !== undefined);
		const generationMs = measured.reduce((sum, turn) => sum + turn.generationMs!, 0);
		const average = (value: (turn: StatsTurn) => number) => rows.reduce((sum, turn) => sum + value(turn), 0) / rows.length;
		return {
			key, label: `${modelLabel(rows[0]!)} · ${turnModeLabel(rows[0]!)}`, prompts: rows.length,
			median: percentile(times, 0.5), p90: percentile(times, 0.9),
			input: average((turn) => (turn.inputTokens ?? 0) + (turn.cacheReadTokens ?? 0) + (turn.cacheWriteTokens ?? 0)),
			output: average((turn) => turn.outputTokens),
			tps: generationMs > 0 ? measured.reduce((sum, turn) => sum + turn.outputTokens, 0) * 1000 / generationMs : undefined,
			tpsSamples: measured.length,
			tools: average((turn) => Object.values(turn.tools).reduce((a, b) => a + b, 0)),
			cost: average((turn) => turn.cost),
			errors: rows.filter((turn) => turn.outcome === "error").length,
			aborted: rows.filter((turn) => turn.outcome === "aborted").length,
		};
	}).sort((a, b) => b.prompts - a.prompts);
}
/** Pure helpers for the Stats panel. Days are LOCAL calendar days. */

export function dayKey(ms: number | Date): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(d: Date, n: number): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/**
 * Consecutive active days. The current streak survives an empty today (the day
 * is not over) and counts back from yesterday then.
 */
export function streaks(days: Set<string>, today = new Date()): { current: number; longest: number } {
	let day = days.has(dayKey(today)) ? today : addDays(today, -1);
	let current = 0;
	while (days.has(dayKey(day))) {
		current++;
		day = addDays(day, -1);
	}
	let longest = 0;
	for (const k of days) {
		const [y, m, d] = k.split("-").map(Number) as [number, number, number];
		// Only count from the first day of a run.
		if (days.has(dayKey(new Date(y, m - 1, d - 1)))) continue;
		let run = 0;
		while (days.has(dayKey(new Date(y, m - 1, d + run)))) run++;
		longest = Math.max(longest, run);
	}
	return { current, longest };
}

/** `p` in 0..1 over an ascending array; 0 for none. */
export function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

export function duration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return t("{s}s", { s });
	const m = Math.floor(s / 60);
	if (m < 60) return t("{m}m {s}s", { m, s: s % 60 });
	return t("{h}h {m}m", { h: Math.floor(m / 60), m: m % 60 });
}

/** A tool call's time: `340ms`, `2.4s`, then as `duration`. */
export function callDuration(ms: number): string {
	if (ms < 1000) return t("{n}ms", { n: Math.round(ms) });
	if (ms < 60_000) return t("{s}s", { s: (ms / 1000).toFixed(1) });
	return duration(ms);
}

/**
 * The heatmap's columns: `weeks` weeks of days ending with the week holding
 * `today`, each column Monday first. Days after today are null.
 */
export function heatmapWeeks(weeks: number, today = new Date()): (Date | null)[][] {
	const monday = addDays(today, -((today.getDay() + 6) % 7));
	const out: (Date | null)[][] = [];
	for (let w = weeks - 1; w >= 0; w--) {
		const col: (Date | null)[] = [];
		for (let d = 0; d < 7; d++) {
			const day = addDays(monday, d - w * 7);
			col.push(day > today ? null : day);
		}
		out.push(col);
	}
	return out;
}

/** Fallback durations when a provider does not report its window length. */
export const LIMIT_WINDOW_MS: Record<string, number> = { session: 5 * 3_600_000, weekly: 7 * 86_400_000 };

export interface Pace {
	start: number;
	end: number;
	/** Percent per millisecond, averaged over the window so far. */
	rate: number;
	/** Percent at reset if that average holds. */
	projected: number;
	/** When 100% is reached at that pace, if before the reset. */
	runsOut: number | null;
	/** The multiple of the current pace that would land exactly on 100% at reset. */
	room: number;
	/** Under 5% of the window gone: the average says little yet. */
	early: boolean;
}

/** Extrapolates a limit's use to its reset at the window's average pace; null outside the window. */
export function pace(percent: number, resetsAt: number, windowMs: number, now = Date.now()): Pace | null {
	const start = resetsAt - windowMs;
	const elapsed = now - start;
	const left = resetsAt - now;
	if (elapsed <= 0 || left <= 0) return null;
	const rate = percent / elapsed;
	const projected = percent + rate * left;
	return {
		start,
		end: resetsAt,
		rate,
		projected,
		runsOut: percent >= 100 ? now : projected > 100 ? now + (100 - percent) / rate : null,
		room: rate > 0 ? Math.max(0, 100 - percent) / (rate * left) : Infinity,
		early: elapsed < windowMs * 0.05,
	};
}

/** A coarse span: `2d 3h`, `3h 20m`, `45m`. */
export function span(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60_000));
	if (m < 60) return t("{m}m", { m });
	const h = Math.floor(m / 60);
	if (h < 24) return t("{h}h {m}m", { h, m: m % 60 });
	return t("{d}d {h}h", { d: Math.floor(h / 24), h: h % 24 });
}
