import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  PiEvent,
  PiMessage,
  PiTool,
  ToolSource,
} from "../shared/types.js";
import { isRecord } from "./guards.js";
import { recordedAnchorSources } from "../shared/anchorHistory.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const READ_TOOLS = new Set([
  "read",
  "read_symbol",
  "read_enclosing",
  "anchor_grep",
]);
type Anchor = {
  path: string;
  token: string;
  text: string;
  line: number;
  hash: string;
};
type Pending = { name: string; path?: string; before?: string };

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** An exact whole-line match must occur only once; duplicates are not evidence of a location. */
function uniqueLine(content: string, lines: string[]): number | undefined {
  if (!lines.length) return;
  const haystack = "\n" + content + "\n";
  const needle = "\n" + lines.join("\n") + "\n";
  const at = haystack.indexOf(needle);
  if (at < 0 || haystack.includes(needle, at + 1)) return;
  return haystack.slice(0, at).split("\n").length;
}

function flatten(messages: PiMessage[]): PiTool[] {
  const tools: PiTool[] = [];
  const visit = (tool: PiTool, depth = 0, batchResult = "") => {
    if (depth > 32) return;
    const name = tool.name.split(".").pop() ?? "";
    tools.push(
      READ_TOOLS.has(name) && !tool.result
        ? { ...tool, result: batchResult }
        : tool,
    );
    for (const child of tool.children ?? [])
      visit(child, depth + 1, tool.result || batchResult);
  };
  for (const message of messages)
    for (const block of message.blocks) if (block.kind === "tool") visit(block);
  return tools;
}

/** Session-private display metadata. No edits, repository scans, or changes to model-visible arguments. */
export class ToolSourceTracker {
  private sources = new Map<string, ToolSource>();
  private anchors = new Map<string, Map<string, Anchor>>();
  private pending = new Map<string, Pending>();
  private file: string;
  private dirty = false;

  constructor(
    key: string,
    private cwd: string,
  ) {
    this.file = statePath(`tool-sources-${hash(key)}.json`);
    try {
      const saved: unknown = JSON.parse(readStateFile(this.file) ?? "null");
      if (!isRecord(saved) || saved.v !== 1) return;
      for (const row of (Array.isArray(saved.sources)
        ? saved.sources
        : []
      ).slice(-MAX_ENTRIES)) {
        if (
          !Array.isArray(row) ||
          typeof row[0] !== "string" ||
          !isRecord(row[1]) ||
          typeof row[1].path !== "string"
        )
          continue;
        this.sources.set(row[0], {
          path: row[1].path,
          ...(positive(row[1].line) ? { line: row[1].line } : {}),
          ...(positive(row[1].currentLine)
            ? { currentLine: row[1].currentLine }
            : {}),
          ...(Array.isArray(row[1].removed) &&
          row[1].removed.every((line) => typeof line === "string")
            ? { removed: row[1].removed }
            : {}),
        });
      }
      for (const row of (Array.isArray(saved.anchors)
        ? saved.anchors
        : []
      ).slice(-MAX_ENTRIES)) {
        if (
          isRecord(row) &&
          typeof row.path === "string" &&
          typeof row.token === "string" &&
          /^[A-Za-z0-9]{4}$/.test(row.token) &&
          typeof row.text === "string" &&
          typeof row.hash === "string" &&
          positive(row.line)
        ) {
          this.remember(row as Anchor);
        }
      }
      this.dirty = false;
    } catch {
      /* Missing or damaged rendering metadata must not prevent opening a session. */
    }
  }

  private read(path: string): string | undefined {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_BYTES) return;
      return normalize(readFileSync(path, "utf8"));
    } catch {
      return;
    }
  }

  private remember(anchor: Anchor): void {
    const paths = this.anchors.get(anchor.token) ?? new Map<string, Anchor>();
    const previous = paths.get(anchor.path);
    if (
      previous?.text === anchor.text &&
      previous.line === anchor.line &&
      previous.hash === anchor.hash
    )
      return;
    paths.set(anchor.path, anchor);
    this.anchors.set(anchor.token, paths);
    if (this.anchors.size > MAX_ENTRIES) {
      const oldest = this.anchors.keys().next().value;
      if (oldest !== undefined) this.anchors.delete(oldest);
    }
    this.dirty = true;
  }

  private set(id: string, source: ToolSource): void {
    const previous = this.sources.get(id);
    if (
      previous?.path === source.path &&
      previous.line === source.line &&
      previous.currentLine === source.currentLine &&
      JSON.stringify(previous.removed) === JSON.stringify(source.removed)
    )
      return;
    this.sources.set(id, source);
    if (this.sources.size > MAX_ENTRIES) {
      const oldest = this.sources.keys().next().value;
      if (oldest !== undefined) this.sources.delete(oldest);
    }
    this.dirty = true;
  }

  /** Read rows are matched against the file snapshot, not guessed from a read's pagination args. */
  private capture(result: string, path: string, content: string): void {
    let group: { token: string; text: string }[] = [];
    const digest = hash(content);
    const flush = () => {
      const line = uniqueLine(
        content,
        group.map((row) => row.text),
      );
      if (line !== undefined) {
        group.forEach((row, i) =>
          this.remember({ ...row, path, line: line + i, hash: digest }),
        );
      }
      group = [];
    };
    for (const line of result.split("\n")) {
      const match = /^[ +]?([A-Za-z0-9]{4})│(.*)$/.exec(line);
      if (match) group.push({ token: match[1], text: match[2] });
      else flush();
    }
    flush();
  }

  record(frame: Record<string, unknown>): void {
    const id = String(frame.toolCallId ?? "");
    if (frame.type === "tool_execution_start") {
      const name =
        String(frame.toolName ?? "")
          .split(".")
          .pop() ?? "";
      const args = isRecord(frame.args) ? frame.args : {};
      let path =
        typeof args.path === "string"
          ? resolve(this.cwd, args.path)
          : undefined;
      if (
        name === "insert" &&
        typeof args.anchor === "string" &&
        (args.direction === "before" || args.direction === "after")
      ) {
        const candidates = [
          ...(this.anchors.get(args.anchor)?.values() ?? []),
        ].filter((anchor) => !path || anchor.path === path);
        if (candidates.length === 1) {
          const anchor = candidates[0];
          path = anchor.path;
          const content = this.read(path);
          const line =
            content === undefined
              ? undefined
              : hash(content) === anchor.hash
                ? anchor.line
                : uniqueLine(content, [anchor.text]);
          this.set(id, {
            path,
            removed: [],
            ...(line !== undefined
              ? {
                  line: line + (args.direction === "after" ? 1 : 0),
                }
              : {}),
          });
        } else if (path) this.set(id, { path, removed: [] });
      }
      if (
        name === "replace" &&
        typeof args.remove_from === "string" &&
        typeof args.remove_to === "string"
      ) {
        const from = this.anchors.get(args.remove_from);
        const to = this.anchors.get(args.remove_to);
        const candidates = [...(from?.values() ?? [])].filter(
          (a) => to?.has(a.path) && (!path || a.path === path),
        );
        if (candidates.length === 1) {
          const first = candidates[0];
          const last = to?.get(first.path);
          path = first.path;
          const content = this.read(path);
          const digest = content === undefined ? undefined : hash(content);
          // After earlier edits shift a file, match the complete recorded range.
          // An endpoint such as `}` may be ambiguous even when the range is unique.
          const rows =
            last && last.hash === first.hash && last.line >= first.line
              ? [...this.anchors.values()]
                  .flatMap((paths) => {
                    const row = paths.get(first.path);
                    return row &&
                      row.hash === first.hash &&
                      row.line >= first.line &&
                      row.line <= last.line
                      ? [row]
                      : [];
                  })
                  .sort((a, b) => a.line - b.line)
              : [];
          const rangeLine =
            content !== undefined &&
            last &&
            rows.length === last.line - first.line + 1 &&
            rows.every((row, i) => row.line === first.line + i)
              ? uniqueLine(
                  content,
                  rows.map((row) => row.text),
                )
              : undefined;
          const line =
            content === undefined
              ? undefined
              : digest === first.hash
                ? first.line
                : (rangeLine ?? uniqueLine(content, [first.text]));
          const end =
            !last || content === undefined
              ? undefined
              : digest === last.hash
                ? last.line
                : rangeLine !== undefined
                  ? rangeLine + last.line - first.line
                  : uniqueLine(content, [last.text]);
          this.set(id, {
            path,
            ...(line !== undefined && end !== undefined && end >= line
              ? {
                  line,
                  removed: content?.split("\n").slice(line - 1, end),
                }
              : {}),
          });
        } else if (path) this.set(id, { path });
      }
      if (READ_TOOLS.has(name) || name === "replace" || name === "insert") {
        this.pending.set(id, {
          name,
          path,
          ...(path && READ_TOOLS.has(name) ? { before: this.read(path) } : {}),
        });
      }
      this.save();
    } else if (frame.type === "tool_execution_end") {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (!pending?.path || frame.isError === true) return;
      const result = isRecord(frame.result) ? frame.result : {};
      const text = Array.isArray(result.content)
        ? result.content
            .flatMap((b) =>
              isRecord(b) && b.type === "text" && typeof b.text === "string"
                ? [b.text]
                : [],
            )
            .join("")
        : "";
      const content = READ_TOOLS.has(pending.name)
        ? pending.before
        : this.read(pending.path);
      if (content !== undefined && text.length <= MAX_BYTES)
        this.capture(text, pending.path, content);
      this.save();
    }
  }

  /** Older edits may be found in today's referenced files, but cannot gain invented historical line numbers. */
  recover(messages: PiMessage[]): void {
    // Reconstruct old ranges from the session transcript before consulting today's files.
    // This also repairs edits made before pre-edit source capture was introduced.
    const recorded = recordedAnchorSources(
      this.annotate(messages).flatMap((message) => message.blocks),
    );
    for (const [id, source] of recorded) {
      if (source.path && source.removed !== undefined) {
        this.set(id, {
          ...source,
          path: resolve(this.cwd, source.path),
        });
      }
    }
    const tools = flatten(messages);
    const paths = new Set<string>();
    for (const tool of tools) {
      const args = isRecord(tool.args) ? tool.args : {};
      if (typeof args.path === "string")
        paths.add(resolve(this.cwd, args.path));
      const source = this.sources.get(tool.id) ?? tool.source;
      if (source) paths.add(source.path);
    }
    const files = [...paths].slice(0, 64).flatMap((path) => {
      const content = this.read(path);
      return content === undefined ? [] : [{ path, content }];
    });
    // Recorded reads can rebuild anchor/path associations for future edits after a restart.
    for (const tool of tools) {
      const args = isRecord(tool.args) ? tool.args : {};
      if (
        tool.isError ||
        !READ_TOOLS.has(tool.name.split(".").pop() ?? "") ||
        typeof args.path !== "string" ||
        !tool.result ||
        tool.result.length > MAX_BYTES
      )
        continue;
      const path = resolve(this.cwd, args.path);
      const file = files.find((f) => f.path === path);
      if (file) this.capture(tool.result, file.path, file.content);
    }
    for (const tool of tools) {
      if (
        tool.isError ||
        tool.running ||
        !["replace", "insert"].includes(tool.name.split(".").pop() ?? "")
      )
        continue;
      let previous = this.sources.get(tool.id) ?? tool.source;
      if (previous?.line !== undefined) continue;
      const args = isRecord(tool.args) ? tool.args : {};
      if (!previous && typeof args.path === "string")
        previous = { path: resolve(this.cwd, args.path) };
      const insertion = tool.name.split(".").pop() === "insert";
      if (!previous && insertion && typeof args.anchor === "string") {
        const candidates = [...(this.anchors.get(args.anchor)?.keys() ?? [])];
        if (candidates.length === 1)
          previous = { path: candidates[0], removed: [] };
      }
      if (
        !previous &&
        typeof args.remove_from === "string" &&
        typeof args.remove_to === "string"
      ) {
        const to = this.anchors.get(args.remove_to);
        const candidates = [
          ...(this.anchors.get(args.remove_from)?.keys() ?? []),
        ].filter((path) => to?.has(path));
        if (candidates.length === 1) previous = { path: candidates[0] };
      }
      if (previous) this.set(tool.id, previous);
      const lines = insertion ? args.lines : args.replacement_lines;
      if (
        !Array.isArray(lines) ||
        !lines.length ||
        !lines.every((v): v is string => typeof v === "string") ||
        !lines.some((v) => v.trim())
      )
        continue;
      // Refuse to claim uniqueness if the bounded scan omitted referenced files.
      if (!previous?.path && paths.size > 64) continue;
      const needle = "\n" + lines.join("\n") + "\n";
      if (needle.length > MAX_BYTES) continue;
      const candidates = files.filter(
        (f) =>
          (!previous?.path || f.path === previous.path) &&
          ("\n" + f.content + "\n").includes(needle),
      );
      const only = candidates.length === 1 ? candidates[0] : undefined;
      const line = only ? uniqueLine(only.content, lines) : undefined;
      if (only && line !== undefined)
        this.set(tool.id, { ...previous, path: only.path, currentLine: line });
      else if (previous?.currentLine !== undefined)
        this.set(tool.id, { ...previous, currentLine: undefined });
    }
    this.save();
  }

  annotate(messages: PiMessage[]): PiMessage[] {
    const visit = (tool: PiTool): PiTool => ({
      ...tool,
      ...(this.sources.has(tool.id)
        ? { source: this.sources.get(tool.id) }
        : {}),
      ...(tool.children ? { children: tool.children.map(visit) } : {}),
    });
    return messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.kind === "tool" ? { kind: "tool", ...visit(block) } : block,
      ),
    }));
  }

  event(event: PiEvent): PiEvent {
    if (event.type === "tool_start" || event.type === "tool_end") {
      const source = this.sources.get(event.id);
      return source ? { ...event, source } : event;
    }
    if (event.type === "message_done")
      return { ...event, message: this.annotate([event.message])[0] };
    return event;
  }

  save(): void {
    if (!this.dirty) return;
    try {
      const anchors = [...this.anchors.values()]
        .flatMap((paths) => [...paths.values()])
        .slice(-MAX_ENTRIES);
      writeStateFile(
        this.file,
        JSON.stringify({ v: 1, sources: [...this.sources], anchors }),
      );
      this.dirty = false;
    } catch (error) {
      console.error("[pwi] could not save tool source metadata:", error);
    }
  }
}
