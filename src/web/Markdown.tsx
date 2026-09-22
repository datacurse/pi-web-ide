import { memo, useMemo, useState } from "react";
import Markdown, { RuleType, type MarkdownToJSX } from "markdown-to-jsx";

import { extractMath, PLACEHOLDER, type MathSpan } from "./math.js";
import { Math } from "./Math.js";

/**
 * Renders one fenced code block with a copy-to-clipboard button.
 *
 * Deliberately no syntax highlighting: that means a themed highlighter
 * (shiki/highlight.js) plus CSS per color scheme, which is a lot of weight
 * for a feature nobody has asked for yet. Plain monospace first; revisit if
 * it is actually missed.
 */
function CodeBlock({ lang, text }: { lang?: string; text: string }) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			// Clipboard API can be denied/unavailable; failing silently beats a crash.
		}
	};

	return (
		<div className="chat-wide group relative my-2">
			{lang && (
				<div className="absolute top-1.5 left-2 font-mono text-[10px] text-neutral-600 select-none">{lang}</div>
			)}
			<button
				onClick={copy}
				className="absolute top-1.5 right-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 opacity-0 hover:bg-neutral-700 group-hover:opacity-100"
			>
				{copied ? "Copied" : "Copy"}
			</button>
			<pre className="chat-code overflow-x-auto rounded bg-neutral-900 p-2 pt-6 text-neutral-300">
				<code>{text}</code>
			</pre>
		</div>
	);
}

/**
 * A text node's placeholders turned back into rendered math.
 *
 * A text node is where they always land: a placeholder is inert text, so the
 * parser leaves it inside whatever it was written in — a paragraph, a list
 * item, a table cell, a heading — which is exactly why the math survived the
 * parse in the first place. One node can hold several, hence the loop.
 */
function withMath(text: string, math: MathSpan[], key: string | number | undefined) {
	const parts: React.ReactNode[] = [];
	let rest = text;
	let n = 0;
	for (let m = PLACEHOLDER.exec(rest); m; m = PLACEHOLDER.exec(rest)) {
		if (m.index > 0) parts.push(rest.slice(0, m.index));
		const span = math[Number(m[1])];
		// A placeholder with no expression behind it cannot happen from
		// extractMath, but it CAN arrive from prose that contains the
		// private-use codepoints itself. Left as the text it is.
		parts.push(span ? <Math key={`${key}-m${n++}`} span={span} /> : m[0]);
		rest = rest.slice(m.index + m[0].length);
	}
	if (parts.length === 0) return text;
	if (rest) parts.push(rest);
	return <span key={key}>{parts}</span>;
}

/**
 * Route codeBlock/codeInline through our own components instead of the
 * `code`/`pre` tag overrides, and math placeholders back into math.
 *
 * Why not overrides: markdown-to-jsx renders both node kinds through the
 * SAME `code` tag, and the only prop that could distinguish them —
 * `className` — is unreliable: it is present with value `undefined` on
 * BOTH an unlabeled fenced block and genuine inline code, verified against
 * the installed 9.10.2 by direct compiler output, not just reading the
 * (minified) source. `renderRule` sees the AST node directly — `codeBlock`
 * vs `codeInline` is the actual parser decision, not a derived prop — so
 * this is the only discriminator that cannot silently misroute.
 *
 * It is also the only hook markdown-to-jsx offers for a syntax it does not
 * have: there is no way to add an inline rule, so math cannot be parsed here
 * — it is extracted before the parse and substituted back in here.
 */
function makeRenderRule(math: MathSpan[]) {
	return function renderRule(
		next: () => React.ReactNode,
		node: MarkdownToJSX.ASTNode,
		_renderChildren: MarkdownToJSX.ASTRender,
		state: MarkdownToJSX.State,
	) {
		if (node.type === RuleType.codeBlock)
			return <CodeBlock key={state.key} lang={node.lang} text={node.text} />;
		if (node.type === RuleType.codeInline)
			return (
				<code key={state.key} className="rounded bg-neutral-800 px-1 py-0.5 text-[0.85em] text-neutral-300">
					{node.text}
				</code>
			);
		if (node.type === RuleType.text && math.length > 0)
			return withMath(node.text, math, state.key);
		return next();
	};
}

/**
 * Markdown overrides in the app's own tokens, so they follow the theme. Kept
 * intentionally plain (no typography plugin) since this is the only place in
 * the app that needs anything beyond `whitespace-pre-wrap`.
 *
 * `chat-measure` is on the elements that are READ — paragraphs, lists,
 * headings, quotes — and deliberately not on the ones that are SCANNED:
 * code blocks and tables keep the full width of the track, because a
 * horizontal scrollbar on a diff is worse than a long line, and a table
 * squeezed into 66 characters is unreadable in a different way.
 */
const options: MarkdownToJSX.Options = {
	/*
	 * Without this, a reply short enough to hold no block element — "done",
	 * a single sentence — is rendered inline, gets no `<p>`, and therefore
	 * none of the `chat-measure` below: it lands flush against the gutter
	 * while every other row in the transcript starts at the reading
	 * column's left edge. The shortest answers were the misaligned ones.
	 */
	forceBlock: true,
	overrides: {
		a: {
			component: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
				<a {...props} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300">
					{children}
				</a>
			),
		},
		ul: { props: { className: "chat-measure my-2 list-disc pl-5" } },
		ol: { props: { className: "chat-measure my-2 list-decimal pl-5" } },
		blockquote: {
			props: { className: "chat-measure my-1 border-l-2 border-neutral-700 pl-2 text-neutral-400 italic" },
		},
		h1: { props: { className: "chat-measure mt-3 mb-1 text-xl font-semibold" } },
		h2: { props: { className: "chat-measure mt-3 mb-1 text-lg font-semibold" } },
		h3: { props: { className: "chat-measure mt-3 mb-1 text-base font-semibold" } },
		h4: { props: { className: "chat-measure mt-2 mb-1 text-base font-semibold" } },
		table: { props: { className: "chat-wide my-2 border-collapse text-sm" } },
		th: { props: { className: "border border-neutral-800 px-2 py-1 text-left font-semibold" } },
		td: { props: { className: "border border-neutral-800 px-2 py-1" } },
		// Paragraph spacing tracks the text size rather than a fixed 4px: at
		// 17px/1.6 a `my-1` gap is tighter than the line spacing inside the
		// paragraph, which reads as one undifferentiated slab.
		p: { props: { className: "chat-measure my-[0.75em] first:mt-0 last:mb-0" } },
	},
};

/**
 * Assistant prose only. Tool output, bash output, and echoed user input stay
 * plain `whitespace-pre-wrap` — those are verbatim text, not prose, and
 * markdown syntax characters in them (a `#` in a shell comment, a stray `_`
 * in a path) would otherwise get mangled into headings and italics.
 *
 * Memoized on `text`: message blocks are rebuilt into new array/object
 * instances on every snapshot refetch, but the string content of a settled
 * block never changes, so this skips re-parsing the whole document on
 * unrelated state updates. The one block still being streamed necessarily
 * gets a new `text` every delta and reparses — that one is expected to.
 */
export const MarkdownText = memo(function MarkdownText({ text, streaming }: { text: string; streaming?: boolean }) {
	/*
	 * Math out, then markdown. One `useMemo` for both, keyed on the text: the
	 * extraction is a single pass and cheap, but the array identity is what
	 * `renderRule` closes over, and a new one every render would rebuild the
	 * options object and defeat markdown-to-jsx's own memoization.
	 */
	const { source, math } = useMemo(() => extractMath(text), [text]);
	const opts = useMemo(
		() => ({ ...options, renderRule: makeRenderRule(math), optimizeForStreaming: streaming }),
		[math, streaming],
	);
	return <Markdown options={opts}>{source}</Markdown>;
});
