import type { ActivityPhaseGroup } from "../shared/activity.js";
import type { PiBlock, PiMessage, PiPartial } from "../shared/types.js";

/** Only the final assistant message's trailing answer stays outside the folds. */
export function partitionPhaseTurn(messages: PiMessage[], live: boolean): { work: PiMessage[]; answer?: PiMessage } {
	const last = messages.at(-1);
	if (live || !last || last.role !== "assistant" || last.blocks.some((b) => b.kind === "tool")) return { work: messages };
	let cut = last.blocks.length;
	while (cut > 0 && ["text", "image"].includes(last.blocks[cut - 1].kind)) cut--;
	if (cut === last.blocks.length) return { work: messages };
	return {
		work: [...messages.slice(0, -1), ...(cut ? [{ ...last, blocks: last.blocks.slice(0, cut) }] : [])],
		answer: { ...last, blocks: last.blocks.slice(cut) },
	};
}

/** Tool IDs are authoritative; message timestamps locate their receiving cycle. */
export function phaseBlocks(groups: ActivityPhaseGroup[], messages: PiMessage[], partial?: PiPartial): Map<number, PiBlock[]> {
	const result = new Map(groups.map((g) => [g.id, [] as PiBlock[]]));
	const receiving = (at: number) => groups.find((g) => g.kind === "receiving" && (g.end === undefined || g.end > at));
	const add = (blocks: PiBlock[], fallback: ActivityPhaseGroup | undefined) => {
		for (const block of blocks) {
			const group = block.kind === "tool" ? groups.find((g) => g.tools.some((tool) => tool.id === block.id)) ?? fallback : fallback;
			if (group) result.get(group.id)?.push(block);
		}
	};
	for (const message of messages) if (message.role === "assistant") add(message.blocks, receiving(message.timestamp));
	if (partial) add([
		...(partial.thinking ? [{ kind: "thinking" as const, text: partial.thinking }] : []),
		...(partial.text ? [{ kind: "text" as const, text: partial.text }] : []),
		...partial.tools.map((tool) => ({ kind: "tool" as const, ...tool })),
	], groups.findLast((g) => g.kind === "receiving"));
	return result;
}
