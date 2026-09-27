/** Pure helpers for the Stats panel. Days are LOCAL calendar days. */

export function dayKey(ms: number | Date): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
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
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
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

/** Claude's limit windows by `group`: the 5-hour session and the week. */
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
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}
