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
