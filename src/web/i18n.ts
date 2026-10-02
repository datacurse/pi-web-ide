/** English interface text and formatting helpers. */

/** Use the browser's locale for dates and numbers. */
export function locale(): undefined {
	return undefined;
}

function fill(s: string, vars?: Record<string, string | number>): string {
	return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Fill `{name}` placeholders in interface text. */
export function t(en: string, vars?: Record<string, string | number>): string {
	return fill(en, vars);
}

/** Format elapsed work in minutes and seconds, omitting zero minutes. */
export function formatDuration(ms: number): string {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	return seconds < 60 ? t("{s}s", { s: seconds })
		: t("{m}m {s}s", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

/** Choose the singular or plural English count phrase and fill its placeholders. */
export function plural(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
	return fill(n === 1 ? one : other, { n, ...vars });
}

/** Lazily create and reuse a formatter for the browser's locale. */
export function perLocale<T>(make: (locale: string | undefined) => T): () => T {
	let made: { value: T } | null = null;
	return () => {
		if (!made) made = { value: make(locale()) };
		return made.value;
	};
}
