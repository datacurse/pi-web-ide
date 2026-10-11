import { useMemo } from "react";
import type { PiBlock, PiTool } from "../shared/types.js";
import {
  removedRange,
  recordedAnchorSources as anchorSources,
  type AnchorSource,
} from "../shared/anchorHistory.js";

export {
  recordedAnchorSources as anchorSources,
  type AnchorSource,
} from "../shared/anchorHistory.js";

/** Prose deltas do not change the recorded tools used to reconstruct diffs. */
export function useAnchorSources(
  blocks: PiBlock[],
  supplied?: Map<string, AnchorSource>,
) {
  const resolve = useMemo(() => {
    let previous: PiBlock[] = [];
    let sources = new Map<string, AnchorSource>();
    return (current: PiBlock[]) => {
      const tools = current.filter((block) => block.kind === "tool");
      if (
        tools.length !== previous.length ||
        tools.some((tool, i) => tool !== previous[i])
      ) {
        previous = tools;
        sources = anchorSources(tools);
      }
      return sources;
    };
  }, []);
  return useMemo(
    () => supplied ?? resolve(blocks),
    [blocks, supplied, resolve],
  );
}

export type AnchorDiff = AnchorSource &
  (
    | { kind: "replace"; from: string; to: string; added: string[] }
    | {
        kind: "insert";
        anchor: string;
        direction: "before" | "after";
        added: string[];
      }
  );

export function anchorDiff(
  tool: PiTool,
  source?: AnchorSource,
): AnchorDiff | undefined {
  if (!tool.args || typeof tool.args !== "object") return;
  const name = tool.name.split(".").pop();
  const args = tool.args as Record<string, unknown>;
  const location = {
    path:
      tool.source?.path ??
      (typeof args.path === "string" ? args.path : source?.path),
    line: tool.source?.line ?? source?.line,
    currentLine: tool.source?.currentLine ?? source?.currentLine,
  };
  if (name === "insert") {
    const { anchor, direction, lines } = args;
    if (
      typeof anchor !== "string" ||
      !anchor ||
      (direction !== "before" && direction !== "after") ||
      !Array.isArray(lines) ||
      !lines.every((line): line is string => typeof line === "string")
    )
      return;
    return {
      ...location,
      kind: "insert",
      anchor,
      direction,
      added: lines,
      removed: [],
    };
  }
  if (name !== "replace") return;
  const { remove_from: from, remove_to: to, replacement_lines: added } = args;
  if (
    typeof from !== "string" ||
    !from ||
    typeof to !== "string" ||
    !to ||
    !Array.isArray(added) ||
    !added.every((line): line is string => typeof line === "string")
  )
    return;
  // Prefer complete captured/replayed ranges over abbreviated display output.
  return {
    ...location,
    kind: "replace",
    from,
    to,
    added,
    removed:
      tool.source?.removed ??
      source?.removed ??
      removedRange(tool.result ?? "", from, to),
  };
}
