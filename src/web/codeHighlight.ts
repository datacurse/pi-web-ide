import type { HighlightStyle } from "@codemirror/language";

import { darkPlus, loadCodeMirror } from "./codemirror.js";

export type Token = { text: string; cls: string };

let style: Promise<HighlightStyle> | undefined;

/** The editor's Dark+ colours, with their CSS put on the page once (no editor mounts it here). */
function darkPlusStyle() {
	style ??= loadCodeMirror().then((cm) => {
		const s = darkPlus(cm);
		const el = document.createElement("style");
		el.textContent = s.module?.getRules() ?? "";
		document.head.append(el);
		return s;
	});
	return style;
}

/**
 * A fenced block's text split into lines of coloured tokens, or null when
 * its language is unknown. `lang` is matched as a name (`typescript`) and
 * then as an extension (`ts`, `svg`), the two ways people label fences.
 */
export async function highlightLines(lang: string, text: string): Promise<Token[][] | null> {
	const [{ LanguageDescription }, { languages }, { highlightCode }] = await Promise.all([
		import("@codemirror/language"),
		import("@codemirror/language-data"),
		import("@lezer/highlight"),
	]);
	const desc =
		LanguageDescription.matchLanguageName(languages, lang) ?? LanguageDescription.matchFilename(languages, `x.${lang}`);
	if (!desc) return null;
	const [support, hs] = await Promise.all([desc.load(), darkPlusStyle()]);
	const lines: Token[][] = [[]];
	highlightCode(
		text,
		support.language.parser.parse(text),
		hs,
		(t, cls) => lines[lines.length - 1].push({ text: t, cls }),
		() => lines.push([]),
	);
	return lines;
}
