import {
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { stripAnsi } from "fancy-ansi";
import type { PiTool } from "../shared/types.js";
import { toolCategory } from "./workTimeline.js";
import { highlightLines, type Token } from "./codeHighlight.js";
import { FileNavigationContext } from "./fileNavigation.js";
import { ScrollPane } from "./OverlayScrollbar.js";
import { readRelativeToolPaths, subscribeRelativeToolPaths } from "./prefs.js";
import { ToolCwdContext, toolPathLabel } from "./toolPaths.js";

type Hit = { line: number; text: string };
type FileHits = { path: string; hits: Hit[] };

export function isSearchTool(tool: PiTool): boolean {
  return (
    toolCategory({
      ...tool,
      name: tool.name.split(".").at(-1) ?? tool.name,
    }) === "search"
  );
}

function FileMatches({ file, needles }: { file: FileHits; needles: string[] }) {
  const openFile = useContext(FileNavigationContext);
  const cwd = useContext(ToolCwdContext);
  const relative = useSyncExternalStore(
    subscribeRelativeToolPaths,
    readRelativeToolPaths,
    () => true,
  );
  const text = file.hits.map((hit) => hit.text).join("\n");
  const [colored, setColored] = useState<{
    text: string;
    path: string;
    lines: Token[][];
  }>();
  useEffect(() => {
    let live = true;
    void highlightLines(file.path.split(/[\\/]/).at(-1) ?? "", text).then(
      (lines) => {
        if (live && lines) setColored({ text, path: file.path, lines });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [file.path, text]);
  const tokens =
    colored?.text === text && colored.path === file.path
      ? colored.lines
      : file.hits.map((hit) => [{ text: hit.text, cls: "" }]);
  const label = toolPathLabel(file.path, cwd, relative);
  return (
    <section className="border-b border-neutral-800 last:border-b-0">
      <div className="flex items-center gap-2 bg-neutral-900 px-2 py-1 text-meta text-neutral-400">
        <span className="min-w-0 flex-1 break-all">{label}</span>
        <span className="shrink-0 tabular-nums text-neutral-500">
          {file.hits.length}
        </span>
      </div>
      {file.hits.map((hit, i) => {
        const content = (
          <>
            <span className="w-8 shrink-0 text-center tabular-nums text-neutral-500">
              {hit.line}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words font-mono chat-code text-neutral-200">
              {(tokens[i] ?? []).map((token, j) => {
                const needle = needles.find((value) =>
                  token.text.includes(value),
                );
                if (!needle)
                  return (
                    <span key={j} className={token.cls || undefined}>
                      {token.text}
                    </span>
                  );
                return (
                  <span key={j} className={token.cls || undefined}>
                    {token.text.split(needle).map((part, k) => (
                      <span key={k}>
                        {k > 0 && (
                          <mark className="rounded-sm bg-amber-400/20 text-inherit">
                            {needle}
                          </mark>
                        )}
                        {part}
                      </span>
                    ))}
                  </span>
                );
              })}
            </span>
          </>
        );
        return openFile ? (
          <button
            key={i}
            type="button"
            data-custom="search match file navigation"
            title={`Open ${file.path} at line ${hit.line}`}
            onClick={() => openFile(file.path, hit.line)}
            className="flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-neutral-800/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500"
          >
            {content}
          </button>
        ) : (
          <div key={i} className="flex items-baseline gap-2 px-2 py-1">
            {content}
          </div>
        );
      })}
    </section>
  );
}

export function SearchResults({ tool }: { tool: PiTool }) {
  const args =
    tool.args && typeof tool.args === "object"
      ? (tool.args as Record<string, unknown>)
      : {};
  const query = String(args.pattern ?? args.query ?? args.command ?? "");
  const cwd = useContext(ToolCwdContext);
  const relative = useSyncExternalStore(
    subscribeRelativeToolPaths,
    readRelativeToolPaths,
    () => true,
  );
  const scope = [args.path, ...(Array.isArray(args.paths) ? args.paths : [])]
    .filter((value): value is string => typeof value === "string")
    .map((path) => toolPathLabel(path, cwd, relative))
    .join(", ");
  const raw = stripAnsi(tool.result ?? "");
  const { files, remainder } = useMemo(() => {
    let output = raw;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        "output" in parsed &&
        typeof parsed.output === "string"
      )
        output = parsed.output;
    } catch {
      /* Plain search output is expected. */
    }
    const byFile = new Map<string, FileHits>();
    const remainder: string[] = [];
    let path = "";
    for (const row of output.split("\n")) {
      const header = /^=== (.+) ===$/.exec(row);
      if (header) {
        path = header[1];
        continue;
      }
      const anchored = /^\s*(\d+)\s*│\s*(?:[A-Za-z0-9]{4}│)?(.*)$/.exec(row);
      const grep = /^(.+?):(\d+):(?:(\d+):)?(.*)$/.exec(row);
      const file = grep?.[1] ?? (anchored ? path : "");
      const line = grep ? Number(grep[2]) : anchored ? Number(anchored[1]) : 0;
      if (file && line > 0) {
        let group = byFile.get(file);
        if (!group) {
          group = { path: file, hits: [] };
          byFile.set(file, group);
        }
        group.hits.push({ line, text: grep?.[4] ?? anchored?.[2] ?? "" });
      } else if (row.trim()) remainder.push(row);
    }
    return { files: [...byFile.values()], remainder: remainder.join("\n") };
  }, [raw]);
  const needles = useMemo(
    () =>
      args.command
        ? []
        : query
            .split("|")
            .filter(
              (part) =>
                part.length > 1 &&
                part.length < 128 &&
                (args.literal === true || /^[\w ./-]+$/.test(part)),
            )
            .slice(0, 32),
    [query, args.command, args.literal],
  );
  const available = !tool.outputUnavailable && tool.result !== undefined;
  const count = files.reduce((sum, file) => sum + file.hits.length, 0);
  const metadata = Object.entries(args).filter(
    ([key]) => !["pattern", "query", "command", "path", "paths"].includes(key),
  );
  return (
    <div
      data-custom="search query and matches"
      className="my-3 overflow-hidden rounded-sm border border-neutral-800 bg-neutral-900"
    >
      <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1 text-meta text-neutral-500">
        <MagnifyingGlass size={14} aria-hidden />
        <span className="flex-1">Search</span>
        {files.length > 0 && (
          <span className="tabular-nums">
            {count} lines · {files.length} files
          </span>
        )}
        {tool.isError && <span className="text-red-400">Failed</span>}
      </div>
      <div className="px-3 py-2 font-mono chat-code text-neutral-200 whitespace-pre-wrap break-words">
        {query || tool.name}
      </div>
      {(scope || metadata.length > 0) && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-neutral-800 px-3 py-1 text-meta text-neutral-500">
          {scope && <span className="break-all">In {scope}</span>}
          {metadata.map(([key, value]) => (
            <span key={key}>
              {key}: {typeof value === "string" ? value : JSON.stringify(value)}
            </span>
          ))}
        </div>
      )}
      {!available || !raw.trim() ? (
        <div className="border-t border-neutral-800 px-3 py-2 text-meta text-neutral-500">
          {tool.running
            ? "Searching…"
            : !available
              ? "Recorded search results unavailable"
              : "No matches"}
        </div>
      ) : files.length ? (
        <>
          <ScrollPane
            className="max-h-64 border-t border-neutral-800"
            aria-label="Recorded search matches"
          >
            {files.map((file) => (
              <FileMatches key={file.path} file={file} needles={needles} />
            ))}
          </ScrollPane>
          {remainder && (
            <details className="border-t border-neutral-800 px-2 py-1 text-meta text-neutral-500">
              <summary className="cursor-pointer">Additional output</summary>
              <pre className="my-3 whitespace-pre-wrap break-words font-mono chat-code">
                {remainder}
              </pre>
            </details>
          )}
        </>
      ) : (
        <ScrollPane
          className="max-h-64 border-t border-neutral-800"
          innerClassName="px-3 py-2"
        >
          <pre className="whitespace-pre-wrap break-words font-mono chat-code text-neutral-300">
            {remainder || raw}
          </pre>
        </ScrollPane>
      )}
    </div>
  );
}
