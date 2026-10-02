import type { PiTool } from "../shared/types.js";
import { removedRange, type AnchorSource } from "../shared/anchorHistory.js";

export {
  recordedAnchorSources as anchorSources,
  type AnchorSource,
} from "../shared/anchorHistory.js";

export interface AnchorDiff extends AnchorSource {
  from: string;
  to: string;
  added: string[];
}

export function anchorDiff(
  tool: PiTool,
  source?: AnchorSource,
): AnchorDiff | undefined {
  if (
    !(tool.name === "replace" || tool.name.endsWith(".replace")) ||
    !tool.args ||
    typeof tool.args !== "object"
  )
    return;
  const args = tool.args as Record<string, unknown>;
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
    from,
    to,
    added,
    removed:
      tool.source?.removed ??
      source?.removed ??
      removedRange(tool.result ?? "", from, to),
    path:
      tool.source?.path ??
      (typeof args.path === "string" ? args.path : source?.path),
    line: tool.source?.line ?? source?.line,
    currentLine: tool.source?.currentLine ?? source?.currentLine,
  };
}
