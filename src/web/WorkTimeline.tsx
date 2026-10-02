import { CaretRight } from "@phosphor-icons/react";
import type { PiBlock, PiTool } from "../shared/types.js";
import type { TurnActivity } from "../shared/activity.js";
import { RawBlocks } from "./RawOutput.js";
import { currentWorkStatus, explorationLabel, workTimeline, type ThoughtItem } from "./workTimeline.js";

/** Native disclosures keep individual expansion state while streaming updates arrive. */
function Disclosure({ label, children, expanded }: { label: string; children: React.ReactNode; expanded?: boolean }) {
	return <details data-custom="quiet work phase" open={expanded || undefined} className="group/phase my-3">
		<summary className="group/label inline-flex cursor-pointer list-none items-center gap-1.5 chat-prose text-neutral-500 hover:text-neutral-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500 [&::-webkit-details-marker]:hidden">
			{label}<CaretRight size={12} aria-hidden className="opacity-0 transition-opacity group-hover/label:opacity-100 group-focus-visible/label:opacity-100 [[open]>summary>&]:rotate-90 [[open]>summary>&]:opacity-100" />
		</summary>
		<div className="text-neutral-500">{children}</div>
	</details>;
}

function Thought({ item, expanded }: { item: ThoughtItem; expanded?: boolean }) {
	let label = item.active ? "Thinking" : "Thought";
	if (!item.active && item.durationMs !== undefined) {
		const seconds = Math.floor(Math.max(0, item.durationMs) / 1000);
		label = seconds === 0 ? "Thought briefly" : `Thought ${seconds}s`;
	}
	return <Disclosure label={label} expanded={expanded}><RawBlocks blocks={[item.block]} streaming={item.active} /></Disclosure>;
}

function Tool({ tool }: { tool: PiTool }) {
	return <RawBlocks blocks={[{ kind: "tool", ...tool }]} />;
}

export function WorkTimeline({ blocks, activity, running, expanded }: {
	blocks: PiBlock[]; activity?: TurnActivity; running?: boolean; expanded?: boolean;
}) {
	const items = workTimeline(blocks, activity, !!running);
	const status = running ? currentWorkStatus(activity, blocks) : undefined;
	const hasVisibleThinking = items.some((item) => item.kind === "thought" && item.active);
	return <>
		{items.map((item, i) => {
			if (item.kind === "prose") return <RawBlocks key={i} blocks={item.blocks} streaming={running} />;
			if (item.kind === "thought") return <Thought key={i} item={item} expanded={expanded} />;
			return <Disclosure key={i} label={explorationLabel(item.blocks, item.active)} expanded={expanded}>
				{item.entries.map((entry, j) => entry.kind === "thought"
					? <Thought key={j} item={entry} />
					: <Tool key={entry.id} tool={entry} />)}
			</Disclosure>;
		})}
		{status && !(status === "Thinking" && hasVisibleThinking) && <div role="status" className="my-3 chat-prose text-neutral-400">{status}</div>}
	</>;
}
