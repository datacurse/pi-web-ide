/**
 * Pulling TeX out of markdown before markdown can eat it.
 *
 * The delimiters are not the problem — markdown is. `a_{\text{sensor}} =
 * a_{\text{body}} + \underbrace{\alpha \times r}_{\text{tangential}}` contains
 * three underscores, so a markdown parser turns half of it into emphasis and
 * hands the renderer `<em>` tags wrapped around fragments of TeX. By then the
 * expression cannot be reassembled: the source is gone.
 *
 * So the math comes out FIRST, each expression replaced by a placeholder that
 * has no markdown meaning at all, and goes back in at render time (see
 * Markdown.tsx). That ordering is what makes math inside a list item, a table
 * cell or a heading work, which splitting the document into math and non-math
 * segments could never do.
 */

/**
 * One extracted expression. `display` is `$$…$$`/`\[…\]` — its own centered
 * block — versus `$…$`/`\(…\)` inline in a sentence.
 */
export interface MathSpan {
	tex: string;
	display: boolean;
}

export interface Extracted {
	/** The source with every expression replaced by a placeholder. */
	source: string;
	/** The expressions, in the order their placeholders appear. */
	math: MathSpan[];
}

/**
 * Placeholder form: `\uE000<index>\uE001`.
 *
 * Private-use codepoints, so nothing in real prose collides with them, and
 * markdown has no rule that touches either one — no emphasis, no escape, no
 * autolink. The index makes each placeholder addressable, which matters
 * because a paragraph with two expressions becomes ONE text node.
 */
const OPEN = "\uE000";
const CLOSE = "\uE001";

/** Matches one placeholder, capturing its index. Used to split text nodes. */
export const PLACEHOLDER = /\uE000(\d+)\uE001/;

/**
 * Inline math ends at the first unescaped closing delimiter — but `$` is also
 * a dollar sign, and "$5 and $10" is not an expression. TeX never opens with
 * whitespace or closes after it, so requiring a non-space character on both
 * inner edges rejects prose while accepting everything real. A newline inside
 * inline math is rejected for the same reason: `$` at the end of one sentence
 * and the start of the next is money twice, not math.
 */
function inlineEnd(src: string, from: number): number {
	for (let i = from; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "\n") return -1;
		if (c === "$") return /\s/.test(src[i - 1] ?? "") ? -1 : i;
	}
	return -1;
}

/** The end of a delimiter-terminated run, or -1. Escapes are skipped. */
function findClose(src: string, from: number, close: string): number {
	for (let i = from; i < src.length; i++) {
		if (src[i] === "\\" && close !== "\\]" && close !== "\\)") {
			i++;
			continue;
		}
		if (src.startsWith(close, i)) return i;
	}
	return -1;
}

/**
 * Code is verbatim, so it is skipped rather than scanned: a fence full of
 * shell (`echo $PATH`, `awk '{print $1}'`) is the exact thing that would
 * otherwise be read as an expression and rendered as one.
 */
function skipCode(src: string, i: number): number {
	const fence = /^(```+|~~~+)/.exec(src.slice(i));
	if (fence) {
		const end = src.indexOf(fence[1], i + fence[1].length);
		return end === -1 ? src.length : end + fence[1].length;
	}
	// Inline code: N backticks, closed by the same run length.
	const ticks = /^`+/.exec(src.slice(i))?.[0];
	if (!ticks) return i;
	const end = src.indexOf(ticks, i + ticks.length);
	return end === -1 ? i + ticks.length : end + ticks.length;
}

export function extractMath(src: string): Extracted {
	// Cheap bail-out: most messages have no math, and this runs on every
	// streamed delta of the one being written.
	if (!src.includes("$") && !src.includes("\\[") && !src.includes("\\(")) {
		return { source: src, math: [] };
	}

	const math: MathSpan[] = [];
	let out = "";
	let i = 0;

	const push = (tex: string, display: boolean) => {
		out += `${OPEN}${math.length}${CLOSE}`;
		math.push({ tex, display });
	};

	while (i < src.length) {
		const c = src[i];

		if (c === "`") {
			const to = skipCode(src, i);
			out += src.slice(i, to);
			i = to;
			continue;
		}

		// An escaped dollar is a dollar. It stays escaped: markdown resolves
		// `\$` to `$` itself, and unescaping here would produce a delimiter.
		if (c === "\\" && src[i + 1] === "$") {
			out += "\\$";
			i += 2;
			continue;
		}

		if (src.startsWith("$$", i)) {
			const end = findClose(src, i + 2, "$$");
			if (end !== -1) {
				push(src.slice(i + 2, end).trim(), true);
				i = end + 2;
				continue;
			}
		} else if (src.startsWith("\\[", i)) {
			const end = findClose(src, i + 2, "\\]");
			if (end !== -1) {
				push(src.slice(i + 2, end).trim(), true);
				i = end + 2;
				continue;
			}
		} else if (src.startsWith("\\(", i)) {
			const end = findClose(src, i + 2, "\\)");
			if (end !== -1) {
				push(src.slice(i + 2, end).trim(), false);
				i = end + 2;
				continue;
			}
		} else if (c === "$" && !/\s/.test(src[i + 1] ?? " ")) {
			const end = inlineEnd(src, i + 1);
			if (end !== -1) {
				push(src.slice(i + 1, end).trim(), false);
				i = end + 1;
				continue;
			}
		}

		/*
		 * Everything that did not close is ordinary text, INCLUDING a lone
		 * `$$` at the end of a message being streamed: the closing delimiter
		 * is still being typed, and rendering a guess would make the answer
		 * flicker between prose and math as it arrives.
		 */
		out += c;
		i++;
	}

	return { source: out, math };
}
