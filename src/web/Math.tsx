import { useEffect, useState } from "react";
import type katexModule from "katex";

import type { MathSpan } from "./math.js";

/**
 * KaTeX, loaded only once a message actually contains math.
 *
 * It is 270KB of JavaScript plus a woff2 face — more than half the size of
 * this whole app — and most conversations have no math in them at all. A
 * static import would put that on the first paint of every session, including
 * the ones served over an ssh forward from a Pi. So the import is dynamic and
 * module-level: the first expression on the page pays for it, every later one
 * is a cache hit, and a session with no math never downloads it.
 */
type Katex = typeof katexModule;

let loading: Promise<Katex> | null = null;
let loaded: Katex | null = null;

function load(): Promise<Katex> {
	loading ??= import("katex").then((mod) => {
		loaded = mod.default;
		return loaded;
	});
	return loading;
}

/**
 * One expression.
 *
 * `throwOnError: false` is deliberate: a model writes `\undebrace` sooner or
 * later, and KaTeX's own error rendering (the source, in red) says what broke
 * and where. Throwing would take the surrounding message down with it, since
 * this renders inside the transcript.
 */
export function Math({ span }: { span: MathSpan }) {
	const [katex, setKatex] = useState<Katex | null>(loaded);

	useEffect(() => {
		if (katex) return;
		let live = true;
		void load().then((k) => {
			if (live) setKatex(k);
		});
		return () => {
			live = false;
		};
	}, [katex]);

	/*
	 * Until it loads, the TeX source in monospace. Not a spinner and not a
	 * blank: the source is the honest fallback — it is what the author wrote,
	 * it is readable, and it does not reflow the paragraph when the real
	 * rendering replaces it on the same line.
	 */
	if (!katex) {
		return (
			<code className={`text-code-inline text-neutral-400 ${span.display ? "block my-2 text-center" : ""}`}>
				{span.tex}
			</code>
		);
	}

	const html = katex.renderToString(span.tex, {
		displayMode: span.display,
		throwOnError: false,
		// Both renderings: the visual one for the reader, MathML for a screen
		// reader and for copy-paste out of the transcript.
		output: "htmlAndMathml",
	});

	// `span`, never `div`: display math sits inside a markdown paragraph, and a
	// block element there is invalid HTML that React will warn about and the
	// browser will hoist out of the <p>.
	return (
		<span
			className={span.display ? "my-2 block overflow-x-auto text-center" : ""}
			// KaTeX's output is generated from the TeX source by KaTeX itself,
			// with no pass-through of raw input: `\href` is the only vector and
			// it is off by default (`trust: false`).
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
