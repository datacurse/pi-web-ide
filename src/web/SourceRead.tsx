import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PiTool } from "../shared/types.js";
import { api, unwrap } from "./api.js";
import { highlightLines, type Token } from "./codeHighlight.js";
import { dedentBlocks } from "./codeIndent.js";
import { FileNavigationContext } from "./fileNavigation.js";
import { ScrollPane } from "./OverlayScrollbar.js";
import { readRelativeToolPaths, subscribeRelativeToolPaths } from "./prefs.js";
import { ToolCwdContext, toolPathLabel } from "./toolPaths.js";

export function isSourceRead(tool: PiTool): boolean {
  return ["read", "read_symbol", "read_enclosing"].includes(
    tool.name.split(".").at(-1) ?? "",
  );
}

export function SourceRead({ tool }: { tool: PiTool }) {
  const args =
    tool.args && typeof tool.args === "object"
      ? (tool.args as Record<string, unknown>)
      : {};
  const path = typeof args.path === "string" ? args.path : tool.source?.path;
  const cwd = useContext(ToolCwdContext);
  const requested =
    typeof args.offset === "number" && args.offset > 0 ? args.offset : 1;
  const limit =
    typeof args.limit === "number" && args.limit > 0 ? args.limit : undefined;
  const missing =
    tool.outputUnavailable || tool.result === undefined || tool.result === "";
  const fullPath =
    path &&
    (/^(\/|[A-Za-z]:[\\/])/.test(path)
      ? path
      : cwd
        ? `${cwd}/${path}`
        : undefined);
  const requestKey = `${fullPath}:${requested}:${limit}`;
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState<{
    key: string;
    text?: string;
    error?: string;
  }>();
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (
      !visible ||
      !missing ||
      !fullPath ||
      tool.running ||
      tool.name.split(".").at(-1) !== "read"
    )
      return;
    let live = true;
    void unwrap(api.file.$get({ query: { path: fullPath } })).then(
      (file) => {
        if (!live) return;
        if (typeof file.content !== "string") {
          setCurrent({ key: requestKey, error: "File content unavailable" });
          return;
        }
        const lines = file.content.split("\n");
        setCurrent({
          key: requestKey,
          text: lines
            .slice(
              requested - 1,
              limit === undefined ? undefined : requested - 1 + limit,
            )
            .join("\n"),
        });
      },
      (error: unknown) => {
        if (live)
          setCurrent({
            key: requestKey,
            error:
              error instanceof Error
                ? error.message
                : "File could not be loaded",
          });
      },
    );
    return () => {
      live = false;
    };
  }, [
    visible,
    missing,
    fullPath,
    tool.running,
    tool.name,
    requested,
    limit,
    requestKey,
  ]);
  const fallback = current?.key === requestKey ? current : undefined;
  const result = missing ? fallback?.text : tool.result;
  const isCurrent = missing && result !== undefined;
  const raw = result?.split("\n") ?? [];
  const anchored =
    !isCurrent && raw.some((line) => /^[A-Za-z0-9]{4}│/.test(line));
  const footer =
    !isCurrent && result && /\[Showing lines (\d+)[–-](\d+) of/.exec(result);
  const numbered =
    !isCurrent && result && /^\s*(\d+)\s*│[A-Za-z0-9]{4}│/m.exec(result);
  const start = isCurrent
    ? requested
    : footer
      ? Number(footer[1])
      : numbered
        ? Number(numbered[1])
        : (tool.source?.line ??
          (anchored
            ? undefined
            : typeof args.offset === "number"
              ? args.offset
              : tool.name.split(".").at(-1) === "read"
                ? 1
                : undefined));
  const source = anchored
    ? raw
        .filter((line) => /^[A-Za-z0-9]{4}│/.test(line))
        .map((line) => line.slice(5))
    : numbered
      ? raw
          .filter((line) => /^\s*\d+\s*│[A-Za-z0-9]{4}│/.test(line))
          .map((line) => line.replace(/^\s*\d+\s*│[A-Za-z0-9]{4}│/, ""))
      : raw;
  const lines = dedentBlocks([source])[0];
  const text = lines.join("\n");
  const language = path?.split(/[\\/]/).at(-1) ?? "";
  const [colored, setColored] = useState<{
    text: string;
    language: string;
    lines: Token[][];
  }>();
  useEffect(() => {
    let live = true;
    void highlightLines(language, text).then(
      (tokens) => {
        if (live && tokens) setColored({ text, language, lines: tokens });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [language, text]);
  const tokens =
    colored?.text === text && colored.language === language
      ? colored.lines
      : lines.map((line) => [{ text: line, cls: "" }]);
  const openFile = useContext(FileNavigationContext);
  const relative = useSyncExternalStore(
    subscribeRelativeToolPaths,
    readRelativeToolPaths,
    () => true,
  );
  const label = path ? toolPathLabel(path, cwd, relative) : "File unavailable";
  const end =
    start === undefined ? undefined : start + Math.max(lines.length, 1) - 1;
  const range =
    start === undefined
      ? "line unavailable"
      : end === start
        ? `L${start}`
        : `L${start}–${end}`;
  const location = `${label} · ${range}`;
  const gutter = (end ?? 0) >= 100 ? "w-8" : (end ?? 0) >= 10 ? "w-6" : "w-4";
  const pendingRange = `L${requested}${typeof args.limit === "number" ? `–${requested + args.limit - 1}` : ""}`;
  const header = missing
    ? `${label} · ${typeof args.symbol === "string" ? args.symbol : pendingRange}${isCurrent ? " · Current file" : ""}`
    : location;
  return (
    <div
      data-custom="source read excerpt"
      ref={host}
      className="my-3 overflow-hidden rounded-sm border border-neutral-800 bg-neutral-900 font-mono chat-code"
    >
      {path && openFile ? (
        <button
          type="button"
          data-custom="source read file navigation"
          onClick={() => openFile(path, start ?? requested)}
          title={`Open ${path}`}
          className="block w-full border-b border-neutral-800 px-2 py-1 text-left text-meta text-neutral-500 break-all hover:text-neutral-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500"
        >
          {header}
        </button>
      ) : (
        <div className="border-b border-neutral-800 px-2 py-1 text-meta text-neutral-500 break-all">
          {header}
        </div>
      )}
      {result === undefined ? (
        <div className="px-3 py-2 text-meta text-neutral-500">
          {tool.running
            ? "Reading file…"
            : fallback?.error
              ? `Read output unavailable · ${fallback.error}`
              : missing && fullPath
                ? "Loading current file excerpt…"
                : "Read output unavailable"}
        </div>
      ) : (
        <ScrollPane
          className="max-h-64"
          innerClassName="py-2"
          aria-label="Recorded source excerpt"
        >
          {tokens.map((line, i) => (
            <div key={i} className="flex items-baseline px-2">
              <span
                className={`mr-2 ${gutter} shrink-0 select-none text-center tabular-nums text-neutral-500`}
              >
                {start === undefined ? "" : start + i}
              </span>
              <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-neutral-200 [tab-size:2]">
                {line.length
                  ? line.map((token, j) =>
                      token.cls ? (
                        <span key={j} className={token.cls}>
                          {token.text}
                        </span>
                      ) : (
                        token.text
                      ),
                    )
                  : "\u00a0"}
              </pre>
            </div>
          ))}
        </ScrollPane>
      )}
      {(anchored || numbered) && (
        <details className="border-t border-neutral-800 px-2 py-1 text-meta text-neutral-500">
          <summary className="cursor-pointer">Raw read output</summary>
          <pre className="my-3 whitespace-pre-wrap break-words chat-code">
            {result}
          </pre>
        </details>
      )}
    </div>
  );
}
