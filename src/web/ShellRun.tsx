import { useEffect, useRef, useState } from "react";
import { Check, Copy, TerminalWindow } from "@phosphor-icons/react";
import { stripAnsi } from "fancy-ansi";
import type { PiTool } from "../shared/types.js";
import { highlightLines, type Token } from "./codeHighlight.js";
import { ScrollPane } from "./OverlayScrollbar.js";
import { IconButton } from "./ui.js";

export function isShellRun(tool: PiTool): boolean {
  return tool.name.split(".").at(-1) === "bash";
}

function ShellText({
  text,
  command = false,
  tail = false,
}: {
  text: string;
  command?: boolean;
  tail?: boolean;
}) {
  const plain = stripAnsi(text);
  const pane = useRef<HTMLDivElement>(null);
  const [colored, setColored] = useState<{ text: string; lines: Token[][] }>();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!command) return;
    let live = true;
    void highlightLines("bash", plain).then(
      (lines) => {
        if (live && lines) setColored({ text: plain, lines });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [command, plain]);
  useEffect(() => {
    if (!tail || !pane.current) return;
    const element = pane.current;
    // Native details start closed: scroll only once the output becomes visible.
    const observer = new ResizeObserver(() => {
      if (!element.clientHeight) return;
      element.scrollTop = element.scrollHeight;
      observer.disconnect();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [tail, plain]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const lines =
    command && colored?.text === plain
      ? colored.lines
      : plain.split("\n").map((line) => [{ text: line, cls: "" }]);
  return (
    <div className="group/shell relative">
      <IconButton
        label={copied ? "Copied" : command ? "Copy command" : "Copy output"}
        size="sm"
        className="absolute top-1 right-1 z-10 opacity-0 group-hover/shell:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          void navigator.clipboard?.writeText(plain).then(
            () => setCopied(true),
            () => {},
          );
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
      <ScrollPane
        ref={pane}
        className="max-h-64"
        innerClassName="px-2 py-2 pr-9"
      >
        <pre
          className={`whitespace-pre-wrap break-words font-mono chat-code ${command ? "text-neutral-200" : "text-neutral-400"} [tab-size:2]`}
        >
          <code>
            {lines.map((line, i) => {
              const raw = line.map((token) => token.text).join("");
              const match = !command && /^([^\s:]+):(\d+):(.*)$/.exec(raw);
              const error =
                !command &&
                /\berror TS\d+\b|SyntaxError:|^\[error\]|^Command exited with code [1-9]/.test(
                  raw,
                );
              const color = error
                ? "text-red-400"
                : !command && /^(diff --git|@@|\+\+\+|---)/.test(raw)
                  ? "text-neutral-500"
                  : !command && raw.startsWith("+")
                    ? "text-green-400"
                    : !command && raw.startsWith("-")
                      ? "text-red-400"
                      : "";
              return (
                <span key={i} className={`block ${color}`}>
                  {match ? (
                    <>
                      <span className="text-neutral-500">{match[1]}:</span>
                      <span className="text-amber-400">{match[2]}</span>
                      <span className="text-neutral-500">:</span>
                      {match[3]}
                    </>
                  ) : line.length ? (
                    line.map((token, j) =>
                      token.cls ? (
                        <span key={j} className={token.cls}>
                          {token.text}
                        </span>
                      ) : (
                        token.text
                      ),
                    )
                  ) : (
                    "\u00a0"
                  )}
                </span>
              );
            })}
          </code>
        </pre>
      </ScrollPane>
    </div>
  );
}

export function ShellRun({ tool }: { tool: PiTool }) {
  const args =
    tool.args && typeof tool.args === "object"
      ? (tool.args as Record<string, unknown>)
      : {};
  const command = typeof args.command === "string" ? args.command : "";
  const available = !tool.outputUnavailable && tool.result !== undefined;
  const plain = stripAnsi(tool.result ?? "");
  const exit = /Command exited with code (\d+)/.exec(plain)?.[1];
  const status = tool.running
    ? "Running"
    : tool.interrupted
      ? "Interrupted"
      : tool.isError
        ? exit
          ? `Exit ${exit}`
          : "Failed"
        : tool.isError === false
          ? "Completed"
          : undefined;
  const error = tool.isError
    ? plain
        .split("\n")
        .find((line) => /\berror TS\d+\b|SyntaxError:/.test(line))
    : undefined;
  const metadata = Object.entries(args).filter(([key]) => key !== "command");
  const hint = metadata
    .map(
      ([key, value]) =>
        `${key}: ${key === "timeout" && typeof value === "number" ? `${value}s` : typeof value === "string" ? value : JSON.stringify(value)}`,
    )
    .join(" · ");
  return (
    <div
      data-custom="shell command and output"
      className="my-3 overflow-hidden rounded-sm border border-neutral-800 bg-neutral-900"
    >
      <div
        title={hint || undefined}
        className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1 text-meta text-neutral-500"
      >
        <TerminalWindow size={14} aria-hidden />
        <span className="flex-1">Terminal</span>
        {tool.durationMs !== undefined && (
          <span className="tabular-nums">
            {(tool.durationMs / 1000).toFixed(1)}s
          </span>
        )}
        {status && (
          <span className={tool.isError ? "text-red-400" : undefined}>
            {status}
          </span>
        )}
      </div>
      {command ? (
        <ShellText text={command} command />
      ) : (
        <div className="px-2 py-2 text-meta text-neutral-500">
          Command unavailable
        </div>
      )}
      {error && (
        <div className="border-t border-neutral-800 px-2 py-2 font-mono text-meta text-red-400 break-words">
          {error}
        </div>
      )}
      <div className="border-t border-neutral-800">
        {available && tool.result?.trim() ? (
          <ShellText text={tool.result} tail={!!tool.isError} />
        ) : (
          <div className="px-2 py-2 text-meta text-neutral-500">
            {tool.running
              ? "Waiting for output…"
              : !available
                ? "Recorded output unavailable"
                : "No output"}
          </div>
        )}
      </div>
      {metadata.some(([key]) => key !== "timeout") && (
        <div className="border-t border-neutral-800 px-2 py-1 text-meta text-neutral-500 break-words">
          {hint}
        </div>
      )}
    </div>
  );
}
