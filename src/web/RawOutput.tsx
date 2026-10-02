import type { PiBlock, PiTool } from "../shared/types.js";
import { MarkdownText } from "./Markdown.js";
import { toolDescription } from "./workTimeline.js";

function ToolLabel({ tool }: { tool: PiTool }) {
	const description = toolDescription(tool);
	const separator = description === tool.name ? -1 : description.indexOf(" ");
	const action = separator < 0 ? description : description.slice(0, separator);
	const parameters = separator < 0 ? "" : description.slice(separator);
	return <><span className="text-neutral-200">{action}</span>{parameters && <span className="text-neutral-500">{parameters}</span>}</>;
}

/** Markdown model prose, with literal tool payloads collapsed by default. */
export function RawBlocks({ blocks, streaming }: { blocks: PiBlock[]; streaming?: boolean }) {
	return <>{blocks.map((block, i) => {
		if (block.kind === "image") return <img key={i} data-custom="raw output image" alt="Message attachment" src={`data:${block.mimeType};base64,${block.data}`} className="my-3 max-w-full" />;
		if (block.kind === "tool") return <details key={block.id} data-custom="raw tool disclosure" className={`my-3 ${block.isError ? "text-red-300" : "text-neutral-300"}`}>
			<summary className="cursor-pointer list-none font-mono chat-code [&::-webkit-details-marker]:hidden"><ToolLabel tool={block} /></summary>
			<pre data-custom="raw tool input" className="my-3 whitespace-pre-wrap break-words font-mono chat-code">{JSON.stringify(block.args, null, 2)}</pre>
			{block.result !== undefined && <pre data-custom="raw tool output" className="my-3 whitespace-pre-wrap break-words font-mono chat-code">{block.result}</pre>}
			{block.children && <RawBlocks blocks={block.children.map((child) => ({ kind: "tool", ...child }))} />}
		</details>;
		return <div key={i} data-custom="raw model output" className={`chat-prose ${block.kind === "thinking" ? "text-neutral-500" : "text-neutral-100"}`}><MarkdownText text={block.text} streaming={streaming} /></div>;
	})}</>;
}
