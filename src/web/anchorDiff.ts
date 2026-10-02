import type { PiBlock, PiTool } from "../shared/types.js";

export interface AnchorSource {
  path?: string;
  line?: number;
  currentLine?: number;
  removed?: string[];
}

export interface AnchorDiff extends AnchorSource {
  from: string;
  to: string;
  added: string[];
}

/** Extract only this edit's removed range from a codemode batch's recorded diff. */
function removedRange(
  result: string,
  from: string,
  to: string,
): string[] | undefined {
  const lines = result.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const start = /^-([A-Za-z0-9]{4})│(.*)$/.exec(lines[i]);
    if (start?.[1] !== from) continue;
    const removed: string[] = [];
    for (let j = i; j < lines.length; j++) {
      const match = /^-([A-Za-z0-9]{4})│(.*)$/.exec(lines[j]);
      if (!match) break;
      removed.push(match[2]);
      if (match[1] === to) return removed;
    }
  }
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
  // These are the tool's recorded old lines, not today's file contents.
  return {
    from,
    to,
    added,
    removed:
      removedRange(tool.result ?? "", from, to) ??
      tool.source?.removed ??
      source?.removed,
    path:
      tool.source?.path ??
      (typeof args.path === "string" ? args.path : source?.path),
    line: tool.source?.line ?? source?.line,
    currentLine: tool.source?.currentLine ?? source?.currentLine,
  };
}

/** Resolve bare anchors through earlier reads; saved codemode results also contain their children's diffs. */
export function anchorSources(blocks: PiBlock[]): Map<string, AnchorSource> {
  const anchors = new Map<string, string>();
  const sources = new Map<string, AnchorSource>();
  const reads = new Map<
    string,
    { rows: { token: string; text: string }[]; index: number }
  >();
  const readTools = new Set(["read", "read_symbol", "read_enclosing"]);
  const isRead = (tool: PiTool): boolean =>
    !tool.isError &&
    (tool.children?.length
      ? tool.children.every(isRead)
      : readTools.has(tool.name.split(".").pop() ?? ""));
  const rememberRead = (result: string) => {
    let rows: { token: string; text: string }[] = [];
    const flush = () => {
      rows.forEach((row, index) => reads.set(row.token, { rows, index }));
      rows = [];
    };
    for (const line of result.split("\n")) {
      const match = /^([A-Za-z0-9]{4})│(.*)$/.exec(line);
      if (match) rows.push({ token: match[1], text: match[2] });
      else flush();
    }
    flush();
  };
  const readRange = (from: string, to: string): string[] | undefined => {
    const first = reads.get(from);
    const last = reads.get(to);
    if (!first || !last || first.rows !== last.rows || last.index < first.index)
      return;
    return first.rows.slice(first.index, last.index + 1).map((row) => row.text);
  };
  const visit = (tool: PiTool, batchResult = "") => {
    const args =
      tool.args && typeof tool.args === "object"
        ? (tool.args as Record<string, unknown>)
        : {};
    const from =
      typeof args.remove_from === "string" ? args.remove_from : undefined;
    const to = typeof args.remove_to === "string" ? args.remove_to : undefined;
    const path =
      tool.source?.path ??
      (typeof args.path === "string"
        ? args.path
        : from
          ? anchors.get(from)
          : undefined);
    const removed =
      from && to
        ? (removedRange(tool.result || batchResult, from, to) ??
          readRange(from, to))
        : undefined;
    sources.set(tool.id, {
      path,
      ...tool.source,
      removed: tool.source?.removed ?? removed,
    });
    // Never reuse a read snapshot across a mutation: intermediate lines may have changed.
    const name = tool.name.split(".").pop() ?? "";
    if (
      [
        "replace",
        "insert",
        "write",
        "edit",
        "bash",
        "undo_last_change",
      ].includes(name)
    )
      reads.clear();
    // A read-only batch is safe to index as a whole; mixed batches need individual outputs.
    if (isRead(tool) && tool.result) rememberRead(tool.result);
    if (path) {
      for (const line of (tool.result ?? "").split("\n")) {
        const match = /^[ +]?([A-Za-z0-9]{4})│/.exec(line);
        if (match) anchors.set(match[1], path);
      }
    }
    for (const child of tool.children ?? [])
      visit(child, tool.result || batchResult);
  };
  for (const block of blocks) if (block.kind === "tool") visit(block);
  return sources;
}
