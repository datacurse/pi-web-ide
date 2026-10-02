import { useEffect, useState } from "react";
import { highlightLines, type Token } from "./codeHighlight.js";
import type { AnchorDiff as Diff } from "./anchorDiff.js";
import { dedentBlocks } from "./codeIndent.js";

/** The chat code view's syntax parser and theme, over a quiet red/green diff surface. */
function SourceLines({ lines, path, removed }: { lines: string[]; path?: string; removed?: boolean }) {
	const text = lines.join("\n");
	const [colored, setColored] = useState<{ text: string; path: string; lines: Token[][] }>();
	useEffect(() => {
		if (!path) return;
		let live = true;
		highlightLines(path.split("/").pop()!, text).then(
			(tokens) => { if (live && tokens) setColored({ text, path, lines: tokens }); },
			() => {}, // Unsupported languages remain readable plain source.
		);
		return () => { live = false; };
	}, [path, text]);
	const tokens = colored?.text === text && colored.path === path ? colored.lines
		: lines.map((line) => [{ text: line, cls: "" }]);
	return <div aria-label={removed ? "Removed lines" : "Replacement lines"}
		className={removed ? "border-l-2 border-red-400 bg-red-400/10 py-2" : "border-l-2 border-green-400 bg-green-400/10 py-2"}>
		{tokens.map((line, i) => <div key={i} className="flex px-3">
			<span aria-hidden className={`mr-3 shrink-0 select-none ${removed ? "text-red-300" : "text-green-300"}`}>{removed ? "−" : "+"}</span>
			<pre data-custom="replacement diff source" className="min-w-0 whitespace-pre-wrap break-words font-mono text-neutral-200 [tab-size:4]">
				{line.length ? line.map((token, j) => token.cls ? <span key={j} className={token.cls}>{token.text}</span> : token.text) : "\u00a0"}
			</pre>
		</div>)}
	</div>;
}

export function AnchorDiff({ diff }: { diff: Diff }) {
	const [removed, added] = dedentBlocks([diff.removed ?? [], diff.added]);
	return <div data-custom="anchor replacement diff" className="my-3 overflow-hidden rounded-sm border border-neutral-800 font-mono chat-code">
		{diff.removed ? <SourceLines lines={removed} path={diff.path} removed />
			: <div aria-label="Removed range" className="border-l-2 border-red-400 bg-red-400/10 px-3 py-2 text-red-300">
				<span aria-hidden className="mr-3 select-none">−</span>
				{diff.from === diff.to ? `Remove line ${diff.from}` : `Remove lines ${diff.from} → ${diff.to} (inclusive)`}
				<span className="ml-3 text-meta text-neutral-500">Previous source unavailable in tool result</span>
			</div>}
		{added.length ? <SourceLines lines={added} path={diff.path} />
			: <div className="px-3 py-2 text-meta text-neutral-500">Deletion only · no replacement lines</div>}
	</div>;
}
