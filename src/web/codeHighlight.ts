import type { HighlightStyle } from "@codemirror/language";

import { loadCodeMirror, syntaxStyle } from "./codemirror.js";

export type Token = { text: string; cls: string };

let style: Promise<HighlightStyle> | undefined;

/** The app theme's syntax colours, with their CSS put on the page once (no editor mounts it here). */
function appSyntaxStyle() {
  style ??= loadCodeMirror().then((cm) => {
    const s = syntaxStyle(cm, "tk");
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
export async function highlightLines(
  lang: string,
  text: string,
): Promise<Token[][] | null> {
  const [{ LanguageDescription }, { languages }, { highlightCode }] =
    await Promise.all([
      import("@codemirror/language"),
      import("@codemirror/language-data"),
      import("@lezer/highlight"),
    ]);
  const desc =
    LanguageDescription.matchLanguageName(languages, lang) ??
    LanguageDescription.matchFilename(languages, lang) ??
    LanguageDescription.matchFilename(languages, `x.${lang}`);
  if (!desc) return null;
  const [support, hs] = await Promise.all([desc.load(), appSyntaxStyle()]);
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
