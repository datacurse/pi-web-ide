import type { PiMessage, PiTool } from "./types.js";

/** Build a forest without mutating snapshots; missing parents stay visible. */
export function nestTools(tools: PiTool[]): PiTool[] {
  const nodes = new Map<string, PiTool>();
  const add = (tool: PiTool, parentId = tool.parentId, depth = 0) => {
    if (depth > 32 || nodes.has(tool.id)) return;
    nodes.set(tool.id, { ...tool, parentId, children: undefined });
    for (const child of tool.children ?? []) add(child, tool.id, depth + 1);
  };
  for (const tool of tools) add(tool);
  const roots: PiTool[] = [];
  for (const node of nodes.values()) {
    let ancestor = node.parentId;
    const seen = new Set([node.id]);
    while (ancestor && nodes.has(ancestor) && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = nodes.get(ancestor)?.parentId;
    }
    const parent =
      ancestor && seen.has(ancestor)
        ? undefined
        : nodes.get(node.parentId ?? "");
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  }
  return roots;
}

/** A batch's live children belong on its settled call, never as sibling cards. */
export function mergeLiveTools(
  messages: PiMessage[],
  tools: PiTool[],
): { messages: PiMessage[]; liveTools: PiTool[] } {
  const represented = new Set(tools.map((tool) => tool.id));
  const referenced = new Set(tools.map((tool) => tool.parentId));
  const parents = messages.flatMap((message) =>
    message.blocks.flatMap((block) =>
      block.kind === "tool" &&
      referenced.has(block.id) &&
      !represented.has(block.id)
        ? [{ ...block, children: undefined }]
        : [],
    ),
  );
  const live = new Map(
    nestTools([...parents, ...tools]).map((tool) => [tool.id, tool]),
  );
  const merge = (saved: PiTool, current: PiTool): PiTool => {
    const children = new Map(
      (saved.children ?? []).map((child) => [child.id, child]),
    );
    for (const child of current.children ?? []) {
      const previous = children.get(child.id);
      children.set(child.id, previous ? merge(previous, child) : child);
    }
    return {
      ...saved,
      ...current,
      result: saved.outputUnavailable
        ? (current.result ?? saved.result)
        : (saved.result ?? current.result),
      source: current.source ?? saved.source,
      isError: saved.result === undefined ? current.isError : saved.isError,
      durationMs: saved.durationMs ?? current.durationMs,
      running: saved.result !== undefined ? false : current.running,
      children: children.size ? [...children.values()] : undefined,
      childrenIncomplete:
        saved.childrenIncomplete ?? current.childrenIncomplete,
      outputUnavailable:
        current.result !== undefined
          ? current.outputUnavailable
          : saved.outputUnavailable,
    };
  };
  const merged = messages.map((message) => ({
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.kind !== "tool") return block;
      const tool = live.get(block.id);
      if (!tool) return block;
      live.delete(block.id);
      return { kind: "tool" as const, ...merge(block, tool) };
    }),
  }));
  return { messages: merged, liveTools: [...live.values()] };
}
