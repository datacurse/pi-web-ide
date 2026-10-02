import { useContext, useEffect, useState } from "react";
import { highlightLines, type Token } from "./codeHighlight.js";
import type { AnchorDiff as Diff } from "./anchorDiff.js";
import { dedentBlocks } from "./codeIndent.js";
import { FileNavigationContext } from "./fileNavigation.js";

/** The chat code view's syntax parser and theme, over a quiet red/green diff surface. */
function SourceLines({ lines, location, removed, gutterWidth }: { lines: string[]; location: Pick<Diff, "path" | "line" | "currentLine">; removed?: boolean; gutterWidth: string }) {
	const { path } = location;
	const startLine = location.line ?? location.currentLine;
	const current = location.line === undefined && location.currentLine !== undefined;
	const text = lines.join("\n");
	const language = path?.split("/").pop() || "typescript";
	const [colored, setColored] = useState<{ text: string; language: string; lines: Token[][] }>();
	useEffect(() => {
		let live = true;
		highlightLines(language, text).then(
			(tokens) => { if (live && tokens) setColored({ text, language, lines: tokens }); },
			() => {}, // Unsupported languages remain readable plain source.
		);
		return () => { live = false; };
	}, [language, text]);
	const tokens = colored?.text === text && colored.language === language ? colored.lines
		: lines.map((line) => [{ text: line, cls: "" }]);
	return <div aria-label={removed ? "Removed lines" : "Replacement lines"} data-language={language}
		className={removed ? "border-l-2 border-red-400 bg-red-400/10 py-2" : "border-l-2 border-green-400 bg-green-400/10 py-2"}>
		{tokens.map((line, i) => <div key={i} className="flex items-baseline px-2">
			<span aria-label={`${removed ? "Removed" : "Replacement"} ${startLine === undefined ? "snippet" : current ? "current file" : "file"} line ${(startLine ?? 1) + i}`} title={startLine === undefined ? "Line within this snippet" : current ? "Diff aligned to current file location" : "File line at time of edit"} className={`mr-2 ${gutterWidth} shrink-0 select-none text-center tabular-nums text-neutral-500`}>{(startLine ?? 1) + i}</span>
			<pre data-custom="replacement diff source" className="min-w-0 whitespace-pre-wrap break-words font-mono text-neutral-200 [tab-size:4]">
				{line.length ? line.map((token, j) => token.cls ? <span key={j} className={token.cls}>{token.text}</span> : token.text) : "\u00a0"}
			</pre>
		</div>)}
	</div>;
}

export function AnchorDiff({ diff }: { diff: Diff }) {
	const openFile = useContext(FileNavigationContext);
	const path = diff.path;
	const [removed, added] = dedentBlocks([diff.removed ?? [], diff.added]);
	const startLine = diff.line ?? diff.currentLine;
	const current = diff.line === undefined && diff.currentLine !== undefined;
	const lastLine = (startLine ?? 1) + Math.max(removed.length, added.length, 1) - 1;
	const gutterWidth = lastLine >= 100 ? "w-8" : lastLine >= 10 ? "w-6" : "w-4";
	return <div data-custom="anchor replacement diff" className="my-3 overflow-hidden rounded-sm border border-neutral-800 font-mono chat-code">
		{path && openFile ? <button type="button" data-custom="replacement file navigation"
			onClick={() => openFile(path, diff.currentLine ?? diff.line)}
			title={`Open ${path}${startLine !== undefined ? ` at line ${diff.currentLine ?? startLine}` : ""}`}
			className="block w-full cursor-pointer border-b border-neutral-800 px-2 py-1 text-left font-mono text-meta text-neutral-500 break-all hover:text-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500">
			{diff.path}{startLine !== undefined ? ` · L${startLine}${current ? " (current)" : " at edit"}` : " · line unavailable"}
		</button> : <div data-custom="replacement file location" className="border-b border-neutral-800 px-2 py-1 text-meta text-neutral-500 break-all">
			{diff.path ?? "File unavailable"}
			{startLine !== undefined ? ` · L${startLine}${current ? " (current)" : " at edit"}` : " · line unavailable"}
		</div>}
		{diff.removed ? <SourceLines lines={removed} location={diff} gutterWidth={gutterWidth} removed />
			: <div aria-label="Removed range" className="border-l-2 border-red-400 bg-red-400/10 px-3 py-2 text-red-300">
				{diff.from === diff.to ? `Remove line ${diff.from}` : `Remove lines ${diff.from} → ${diff.to} (inclusive)`}
				<span className="ml-3 text-meta text-neutral-500">Previous source unavailable in tool result</span>
			</div>}
		{added.length ? <SourceLines lines={added} location={diff} gutterWidth={gutterWidth} />
			: <div className="px-3 py-2 text-meta text-neutral-500">Deletion only · no replacement lines</div>}
	</div>;
}
