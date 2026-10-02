import type { PiBlock, PiTool, ToolSource } from "./types.js";

export type AnchorSource = Partial<ToolSource>;
type Row = { tokens: Set<string>; text: string };
type Window = { path?: string; rows: Row[] };
const READS = new Set(["read", "read_symbol", "read_enclosing"]);
// These can accompany source reads without invalidating their recorded snapshots.
const READ_ONLY = new Set([
  ...READS,
  "anchor_grep",
  "module_report",
  "project_report",
  "symbol_search",
  "effective_config",
  "lens_diagnostics",
  "lsp_navigation",
  "ast_grep_search",
  "ast_grep_outline",
  "pi_lens_activate_tools",
]);
const EDITS = new Set([
  "replace",
  "insert",
  "edit",
  "write",
  "undo_last_change",
]);
const MAX_ROWS = 10_000;

function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return true;
  const clean = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  a = clean(a);
  b = clean(b);
  return (
    a === b ||
    (!a.startsWith("/") && b.endsWith("/" + a)) ||
    (!b.startsWith("/") && a.endsWith("/" + b))
  );
}

/** Only recognize a small, literal, read-only shell subset; anything else invalidates snapshots. */
function readOnlyShell(command: unknown): boolean {
  if (typeof command !== "string" || /[$`<>\n\r]/.test(command)) return false;
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s;|&]+|[;|&]+/g) ?? [];
  let words: string[] = [];
  const safe = () =>
    words.length > 0 &&
    (["rg", "head", "tail", "ls", "cat", "pwd", "wc"].includes(words[0])
      ? !words.some((word) => word.startsWith("--pre"))
      : words[0] === "git" && words[1] === "status");
  for (const token of tokens) {
    if (/^[;|&]+$/.test(token)) {
      if (!safe()) return false;
      words = [];
    } else words.push(token.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return words.length ? safe() : tokens.length > 0;
}

/** Compact diffs include unchanged context and interleaved additions, not just '-' rows. */
export function removedRange(
  result: string,
  from: string,
  to: string,
): string[] | undefined {
  let rows: string[] | undefined;
  for (const line of result.split("\n")) {
    const match = /^([ -])([A-Za-z0-9]{4})│(.*)$/.exec(line);
    if (/^\+[A-Za-z0-9]{4}│/.test(line)) continue;
    if (!match) {
      rows = undefined;
      continue;
    }
    if (match[2] === from) rows = [];
    if (!rows) continue;
    rows.push(match[3]);
    if (match[2] === to) return rows;
  }
}

/** Replay recorded source only. Never fill an old diff from the current file. */
class AnchorHistory {
  private windows: Window[] = [];

  remember(result: string, path?: string, diff = false): void {
    let group: { token: string; text: string }[] = [];
    const flush = () => {
      if (!group.length) return;
      const matches: { window: Window; at: number }[] = [];
      for (const window of this.windows) {
        if (!samePath(path, window.path)) continue;
        for (let at = 0; at + group.length <= window.rows.length; at++) {
          if (group.every((row, i) => row.text === window.rows[at + i].text))
            matches.push({ window, at });
        }
      }
      if (matches.length === 1) {
        const { window, at } = matches[0];
        group.forEach((row, i) => window.rows[at + i].tokens.add(row.token));
      } else {
        this.windows.push({
          path,
          rows: group.map((row) => ({
            text: row.text,
            tokens: new Set([row.token]),
          })),
        });
      }
      group = [];
    };
    for (const line of result.split("\n")) {
      // Minus rows describe the old snapshot; context and plus rows describe the new one.
      if (diff && /^-[A-Za-z0-9]{4}│/.test(line)) continue;
      const match = (
        diff ? /^[ +]?([A-Za-z0-9]{4})│(.*)$/ : /^([A-Za-z0-9]{4})│(.*)$/
      ).exec(line);
      if (match) group.push({ token: match[1], text: match[2] });
      else flush(); // Elisions are gaps, never contiguous source.
    }
    flush();
    let size = this.windows.reduce((n, window) => n + window.rows.length, 0);
    while (size > MAX_ROWS && this.windows.length)
      size -= this.windows.shift()!.rows.length;
  }

  /** A saved child may have no result: take only its own hunk from the enclosing batch. */
  rememberEdit(
    result: string,
    path: string | undefined,
    from: string,
    to?: string,
  ): void {
    let hunk: string[] = [];
    let belongs = false;
    const flush = () => {
      if (belongs) this.remember(hunk.join("\n"), path, true);
      hunk = [];
      belongs = false;
    };
    for (const line of result.split("\n")) {
      const row = /^[ +\-]([A-Za-z0-9]{4})│/.exec(line);
      if (!row) {
        flush();
        continue;
      }
      hunk.push(line);
      if (row[1] === from || row[1] === to) belongs = true;
    }
    flush();
  }

  range(from: string, to: string, path?: string): string[] | undefined {
    const candidates = this.windows.flatMap((window) => {
      if (!samePath(path, window.path)) return [];
      const start = window.rows.findIndex((row) => row.tokens.has(from));
      const end = window.rows.findIndex((row) => row.tokens.has(to));
      return start >= 0 && end >= start
        ? [window.rows.slice(start, end + 1).map((row) => row.text)]
        : [];
    });
    const first = candidates[0];
    return first &&
      candidates.every((rows) => JSON.stringify(rows) === JSON.stringify(first))
      ? first
      : undefined;
  }

  replace(from: string, to: string, added: string[], path?: string): void {
    const changed = new Set<string>();
    const patched = new Set<Window>();
    for (const window of this.windows) {
      if (!samePath(path, window.path)) continue;
      const start = window.rows.findIndex((row) => row.tokens.has(from));
      const end = window.rows.findIndex((row) => row.tokens.has(to));
      if (start < 0 || end < start) continue;
      const old = window.rows.slice(start, end + 1);
      // Keep aliases for unchanged prefix/suffix rows, even if the tool refreshes their IDs.
      let prefix = 0;
      while (
        prefix < old.length &&
        prefix < added.length &&
        old[prefix].text === added[prefix]
      )
        prefix++;
      let suffix = 0;
      while (
        suffix < old.length - prefix &&
        suffix < added.length - prefix &&
        old[old.length - 1 - suffix].text === added[added.length - 1 - suffix]
      )
        suffix++;
      old
        .slice(prefix, old.length - suffix)
        .forEach((row) => row.tokens.forEach((token) => changed.add(token)));
      window.rows.splice(
        start + prefix,
        old.length - prefix - suffix,
        ...added
          .slice(prefix, added.length - suffix)
          .map((text) => ({ text, tokens: new Set<string>() })),
      );
      patched.add(window);
    }
    // A partial read overlapping the changed portion cannot remain a competing stale snapshot.
    this.windows = this.windows.filter(
      (window) =>
        patched.has(window) ||
        !window.rows.some((row) =>
          [...row.tokens].some((token) => changed.has(token)),
        ),
    );
    if (!patched.size) this.invalidate(path);
  }

  insert(
    anchor: string,
    direction: string,
    added: string[],
    path?: string,
  ): void {
    let found = false;
    for (const window of this.windows) {
      if (!samePath(path, window.path)) continue;
      const at = window.rows.findIndex((row) => row.tokens.has(anchor));
      if (at < 0) continue;
      window.rows.splice(
        at + (direction === "after" ? 1 : 0),
        0,
        ...added.map((text) => ({ text, tokens: new Set<string>() })),
      );
      found = true;
    }
    if (!found) this.invalidate(path);
  }

  invalidate(path?: string): void {
    this.windows = this.windows.filter(
      (window) => !samePath(path, window.path),
    );
  }
}

/** Resolve nested calls from recorded reads, evolving those snapshots through each successful edit. */
export function recordedAnchorSources(
  blocks: PiBlock[],
): Map<string, AnchorSource> {
  const history = new AnchorHistory();
  const paths = new Map<string, string>();
  const sources = new Map<string, AnchorSource>();
  const nameOf = (tool: PiTool) => tool.name.split(".").pop() ?? "";
  const argsOf = (tool: PiTool): Record<string, unknown> =>
    tool.args && typeof tool.args === "object"
      ? (tool.args as Record<string, unknown>)
      : {};
  const readBatch = (tool: PiTool, depth = 0): boolean => {
    if (depth > 32 || tool.isError) return false;
    if (tool.children?.length)
      return tool.children.every((child) => readBatch(child, depth + 1));
    return (
      READ_ONLY.has(nameOf(tool)) ||
      (nameOf(tool) === "bash" && readOnlyShell(argsOf(tool).command))
    );
  };
  const readPaths = (tool: PiTool, depth = 0): string[] => {
    if (depth > 32) return [];
    if (tool.children?.length)
      return tool.children.flatMap((child) => readPaths(child, depth + 1));
    const args = argsOf(tool);
    return READS.has(nameOf(tool)) && typeof args.path === "string"
      ? [args.path]
      : [];
  };
  const visit = (tool: PiTool, batchResult = "", depth = 0) => {
    if (depth > 32) return;
    const name = nameOf(tool);
    const args = argsOf(tool);
    const from =
      typeof args.remove_from === "string" ? args.remove_from : undefined;
    const to = typeof args.remove_to === "string" ? args.remove_to : undefined;
    const anchor = typeof args.anchor === "string" ? args.anchor : undefined;
    const path =
      tool.source?.path ??
      (typeof args.path === "string"
        ? args.path
        : paths.get(from ?? anchor ?? ""));
    const result = tool.result || batchResult;
    const added =
      Array.isArray(args.replacement_lines) &&
      args.replacement_lines.every(
        (line): line is string => typeof line === "string",
      )
        ? args.replacement_lines
        : undefined;
    const removed =
      name === "replace" && from && to
        ? (tool.source?.removed ??
          history.range(from, to, path) ??
          removedRange(result, from, to))
        : undefined;
    sources.set(tool.id, {
      path,
      ...tool.source,
      removed: tool.source?.removed ?? removed,
    });
    if (!tool.isError && !tool.running && !tool.interrupted) {
      if (name === "replace" && from && to && added)
        history.replace(from, to, added, path);
      else if (
        name === "insert" &&
        anchor &&
        (args.direction === "before" || args.direction === "after") &&
        Array.isArray(args.lines) &&
        args.lines.every((line): line is string => typeof line === "string")
      )
        history.insert(anchor, args.direction, args.lines, path);
      else if (
        EDITS.has(name) ||
        (name === "bash" && !readOnlyShell(args.command))
      )
        history.invalidate(path);
      const canRead =
        READS.has(name) || (tool.children?.length && readBatch(tool));
      if (tool.result && canRead) {
        const files = [...new Set(readPaths(tool))];
        const snapshotPath =
          path ?? (files.length === 1 ? files[0] : undefined);
        history.remember(tool.result, snapshotPath);
        if (snapshotPath) {
          for (const line of tool.result.split("\n")) {
            const row = /^([A-Za-z0-9]{4})│/.exec(line);
            if (row) paths.set(row[1], snapshotPath);
          }
        }
      } else if (result && (name === "replace" || name === "insert")) {
        if (tool.result) history.remember(tool.result, path, true);
        else if (from || anchor)
          history.rememberEdit(result, path, (from ?? anchor)!, to);
      }
    }
    if (path) {
      for (const line of (tool.result ?? "").split("\n")) {
        const match = /^[ +]?([A-Za-z0-9]{4})│/.exec(line);
        if (match) paths.set(match[1], path);
      }
    }
    for (const child of tool.children ?? []) visit(child, result, depth + 1);
  };
  for (const block of blocks) if (block.kind === "tool") visit(block);
  return sources;
}
