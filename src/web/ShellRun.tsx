import { useEffect, useState } from "react";
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
}: {
  text: string;
  command?: boolean;
}) {
  const plain = stripAnsi(text);
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
      <ScrollPane className="max-h-64" innerClassName="px-3 py-2 pr-9">
        <pre className="whitespace-pre-wrap break-words font-mono chat-code text-neutral-200 [tab-size:2]">
          <code>
            {lines.map((line, i) => {
              const raw = line.map((token) => token.text).join("");
              const color =
                !command && /^(diff --git|@@|\+\+\+|---)/.test(raw)
                  ? "text-neutral-500"
                  : !command && raw.startsWith("+")
                    ? "text-green-400"
                    : !command && raw.startsWith("-")
                      ? "text-red-400"
                      : "";
              return (
                <span key={i} className={`block ${color}`}>
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
  const status = tool.running
    ? "Running"
    : tool.interrupted
      ? "Interrupted"
      : tool.isError
        ? "Failed"
        : tool.isError === false
          ? "Completed"
          : undefined;
  const metadata = Object.entries(args).filter(([key]) => key !== "command");
  return (
    <div
      data-custom="shell command and output"
      className="my-3 overflow-hidden rounded-sm border border-neutral-800 bg-neutral-900"
    >
      <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1 text-meta text-neutral-500">
        <TerminalWindow size={14} aria-hidden />
        <span className="flex-1">Shell command</span>
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
        <div className="px-3 py-2 text-meta text-neutral-500">
          Command unavailable
        </div>
      )}
      {metadata.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-neutral-800 px-3 py-1 text-meta text-neutral-500">
          {metadata.map(([key, value]) => (
            <span key={key}>
              {key}:{" "}
              {key === "timeout" && typeof value === "number"
                ? `${value}s`
                : typeof value === "string"
                  ? value
                  : JSON.stringify(value)}
            </span>
          ))}
        </div>
      )}
      <div className="border-t border-neutral-800 px-2 py-1 text-meta text-neutral-500">
        Output
      </div>
      {available && tool.result?.trim() ? (
        <ShellText text={tool.result} />
      ) : (
        <div className="px-3 py-2 text-meta text-neutral-500">
          {tool.running
            ? "Waiting for output…"
            : !available
              ? "Recorded output unavailable"
              : "No output"}
        </div>
      )}
    </div>
  );
}
