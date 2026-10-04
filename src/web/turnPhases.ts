import type { ActivityPhaseGroup } from "../shared/activity.js";
import { mergeLiveTools } from "../shared/toolTree.js";
import type { PiBlock, PiMessage, PiPartial } from "../shared/types.js";

/** Tool IDs are authoritative; message timestamps locate their receiving cycle. */
export function phaseBlocks(
  groups: ActivityPhaseGroup[],
  messages: PiMessage[],
  partial?: PiPartial,
): Map<number, PiBlock[]> {
  const result = new Map(groups.map((g) => [g.id, [] as PiBlock[]]));
  const receiving = (at: number) =>
    groups.find(
      (g) => g.kind === "receiving" && (g.end === undefined || g.end > at),
    );
  const add = (blocks: PiBlock[], fallback: ActivityPhaseGroup | undefined) => {
    for (const block of blocks) {
      const group =
        block.kind === "tool"
          ? (groups.find((g) => g.tools.some((tool) => tool.id === block.id)) ??
            fallback)
          : fallback;
      const target = group ?? groups.at(-1);
      if (target) result.get(target.id)?.push(block);
    }
  };
  const merged = mergeLiveTools(messages, partial?.tools ?? []);
  for (const message of merged.messages)
    if (message.role === "assistant")
      add(message.blocks, receiving(message.timestamp));
  if (partial)
    add(
      [
        ...(partial.thinking
          ? [{ kind: "thinking" as const, text: partial.thinking }]
          : []),
        ...(partial.text
          ? [{ kind: "text" as const, text: partial.text }]
          : []),
        ...merged.liveTools.map((tool) => ({ kind: "tool" as const, ...tool })),
      ],
      groups.findLast((g) => g.kind === "receiving"),
    );
  return result;
}
