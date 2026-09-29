/**
 * Interface translation. The English text is the key, so code reads as it
 * always did and a string with no translation falls back to English.
 *
 * The language is module state rather than React context: `t` is called from
 * plain helpers (time stamps, tooltips) as well as components. App keeps it in
 * state too, so switching re-renders the tree and every `t` call reruns.
 *
 * Every `t`/`plural` call takes a string literal; i18n.test.ts checks each one
 * has a Russian entry.
 */

import { readLanguage, writeLanguage, type Language } from "./prefs.js";
import { RU } from "./i18n.ru.js";

let current: Language = readLanguage();

export function getLanguage(): Language {
	return current;
}

export function setLanguage(lang: Language): void {
	current = lang;
	writeLanguage(lang);
	document.documentElement.lang = lang;
}

/** The locale for `toLocale*String` and `Intl` formatters: the browser's for English. */
export function locale(): string | undefined {
	return current === "ru" ? "ru" : undefined;
}

function fill(s: string, vars?: Record<string, string | number>): string {
	return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** `en` in the current language, with `{name}` placeholders filled from `vars`. */
export function t(en: string, vars?: Record<string, string | number>): string {
	return fill(current === "ru" ? (RU[en] ?? en) : en, vars);
}

const ruPlural = new Intl.PluralRules("ru");

/**
 * A count phrase: `one` or `other` in English. The Russian entry is keyed by
 * `other` and holds three forms, `one|few|many`. `{n}` is the count. A Russian
 * entry for `one` itself, if there is one, wins for exactly 1 ("read a file").
 */
export function plural(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
	const all = { n, ...vars };
	if (current !== "ru") return fill(n === 1 ? one : other, all);
	if (n === 1 && RU[one]) return fill(RU[one], all);
	const forms = (RU[other] ?? `${one}|${other}|${other}`).split("|");
	const i = { one: 0, few: 1 }[ruPlural.select(n) as string] ?? 2;
	return fill(forms[i] ?? forms[0], all);
}

/** A formatter for the interface language, rebuilt only when the language changes. */
export function perLocale<T>(make: (locale: string | undefined) => T): () => T {
	let made: { locale: string | undefined; value: T } | null = null;
	return () => {
		const l = locale();
		if (!made || made.locale !== l) made = { locale: l, value: make(l) };
		return made.value;
	};
}
