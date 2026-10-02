import type { PiBlock } from "../shared/types.js";

/** Literal model text and payloads, with tool details collapsed by default. */
export function RawBlocks({ blocks }: { blocks: PiBlock[] }) {
	return <>{blocks.map((block, i) => {
		if (block.kind === "image") return <img key={i} data-custom="raw output image" alt="Message attachment" src={`data:${block.mimeType};base64,${block.data}`} className="my-3 max-w-full" />;
		if (block.kind === "tool") return <details key={block.id} data-custom="raw tool disclosure" className={`my-3 ${block.isError ? "text-red-300" : "text-neutral-300"}`}>
			<summary className="cursor-pointer list-none font-mono chat-code [&::-webkit-details-marker]:hidden">{block.name}</summary>
			<pre data-custom="raw tool input" className="my-3 whitespace-pre-wrap break-words font-mono chat-code">{JSON.stringify(block.args, null, 2)}</pre>
			{block.result !== undefined && <pre data-custom="raw tool output" className="my-3 whitespace-pre-wrap break-words font-mono chat-code">{block.result}</pre>}
			{block.children && <RawBlocks blocks={block.children.map((child) => ({ kind: "tool", ...child }))} />}
		</details>;
		return <pre key={i} data-custom="raw model output" className={`my-3 whitespace-pre-wrap break-words font-mono chat-code ${block.kind === "thinking" ? "text-neutral-500" : "text-neutral-100"}`}>{block.text}</pre>;
	})}</>;
}
