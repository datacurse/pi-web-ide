import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CaretRight,
  Check,
  Code,
  Copy,
  FileCode,
  Terminal,
} from "@phosphor-icons/react";
import { stripAnsi } from "fancy-ansi";
import type { PiTool } from "../shared/types.js";
import { highlightLines, type Token } from "./codeHighlight.js";
import {
  execCalls,
  execOutput,
  execSource,
  type ExecCall,
} from "./execDisplay.js";
import { IconButton } from "./ui.js";
import { plural, t } from "./i18n.js";

/** Literal, copyable text. Never interpreted as Markdown or executable JavaScript. */
function ExecText({
  text,
  lang,
  patch = false,
}: {
  text: string;
  lang?: string;
  patch?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [colored, setColored] = useState<{
    text: string;
    lang: string;
    lines: Token[][];
  }>();
  useEffect(() => {
    if (!lang || patch) return;
    let live = true;
    highlightLines(lang, text).then(
      (lines) => {
        if (live && lines) setColored({ text, lang, lines });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [text, lang, patch]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const lines =
    colored?.text === text && colored.lang === lang
      ? colored.lines
      : text.split("\n").map((line) => [{ text: line, cls: "" }]);
  return (
    <div className="group/exec relative min-w-0">
      <IconButton
        label={copied ? t("Copied") : t("Copy")}
        size="sm"
        className="absolute top-1 right-1 opacity-0 group-hover/exec:opacity-100 focus-visible:opacity-100"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => {},
          );
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
      <pre className="max-h-80 overflow-auto px-3 py-3 pr-9 font-mono text-meta leading-relaxed whitespace-pre-wrap break-words text-neutral-300 [tab-size:2]">
        <code>
          {lines.map((line, i) => {
            const raw = line.map((token) => token.text).join("");
            const color = patch
              ? raw.startsWith("+")
                ? "bg-green-500/10 text-green-300"
                : raw.startsWith("-")
                  ? "bg-red-500/10 text-red-300"
                  : raw.startsWith("@@") || raw.startsWith("***")
                    ? "text-neutral-500"
                    : ""
              : "";
            return (
              <span key={i} className={`block min-h-4 ${color}`}>
                {line.map((token, j) => (
                  <span key={j} className={token.cls || undefined}>
                    {token.text}
                  </span>
                ))}
                {raw.length === 0 ? "\u00a0" : null}
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

function OriginalText({
  label,
  text,
  lang,
}: {
  label: string;
  text: string;
  lang?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">{label}</summary>
      {open && <ExecText text={text} lang={lang} />}
    </details>
  );
}

function CallInput({ call }: { call: ExecCall }) {
  const [patchOpen, setPatchOpen] = useState(false);
  if (call.command !== undefined)
    return (
      <div className="border-b border-neutral-800 last:border-b-0">
        <div className="flex items-center gap-2 px-3 pt-3 text-caption text-neutral-500">
          <Terminal size={14} />
          <span>{t("Command")}</span>
          {call.cwd && (
            <span className="fade-end ml-auto font-mono" title={call.cwd}>
              {call.cwd}
            </span>
          )}
        </div>
        <ExecText text={call.command} lang="shell" />
      </div>
    );
  if (call.patch !== undefined) {
    const files = [
      ...call.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm),
    ].map((match) => match[1]);
    const lines = call.patch.split("\n");
    const added = lines.filter((line) => line.startsWith("+")).length;
    const removed = lines.filter((line) => line.startsWith("-")).length;
    return (
      <details
        onToggle={(event) => setPatchOpen(event.currentTarget.open)}
        className="border-b border-neutral-800 last:border-b-0"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-meta [&::-webkit-details-marker]:hidden">
          <CaretRight
            size={12}
            className="shrink-0 text-neutral-500 [[open]>summary>&]:rotate-90"
          />
          <FileCode size={14} className="shrink-0 text-neutral-400" />
          <span
            className="fade-end min-w-0 font-mono text-neutral-300"
            title={files.join("\n")}
          >
            {files.length === 1
              ? files[0].split("/").pop()
              : t("{count} files", { count: files.length })}
          </span>
          <span className="ml-auto shrink-0 font-mono text-caption">
            <span className="text-green-400">+{added}</span>{" "}
            <span className="text-red-400">−{removed}</span>
          </span>
        </summary>
        {patchOpen && <ExecText text={call.patch} patch />}
      </details>
    );
  }
  return (
    <div className="border-b border-neutral-800 last:border-b-0">
      <div className="flex items-center gap-2 px-3 pt-3 text-caption text-neutral-500">
        <Code size={14} />
        <span className="font-mono">{call.name}</span>
      </div>
      <ExecText text={call.source} lang="javascript" />
    </div>
  );
}

function Metadata({ values }: { values: Record<string, unknown> }) {
  const { exit_code, session_id, truncated, original_token_count, ...other } =
    values;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-neutral-800 px-3 py-2 text-caption text-neutral-500">
      {typeof exit_code === "number" && (
        <span
          className={`font-mono ${exit_code === 0 ? "text-neutral-400" : "text-red-400"}`}
        >
          {t("Exit {code}", { code: exit_code })}
        </span>
      )}
      {typeof session_id === "number" && (
        <span className="font-mono">
          {t("Session {id}", { id: session_id })}
        </span>
      )}
      {truncated === true && (
        <span className="text-amber-400">{t("Output truncated")}</span>
      )}
      {typeof original_token_count === "number" && (
        <span>{t("{count} tokens", { count: original_token_count })}</span>
      )}
      {Object.keys(other).length > 0 && (
        <div className="w-full">
          <OriginalText
            label={t("Metadata")}
            text={JSON.stringify(other, null, 2)}
            lang="json"
          />
        </div>
      )}
    </div>
  );
}

/** One presentation for historic, live and nested Code/Notebook executions. */
export const ExecBlock = memo(function ExecBlock({
  tool,
  children,
}: {
  tool: PiTool;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const source = execSource(tool.args);
  const calls = useMemo(() => (source ? execCalls(source) : []), [source]);
  const parts = useMemo(
    () => (tool.result !== undefined ? execOutput(tool.result) : []),
    [tool.result],
  );
  const failed =
    tool.isError ||
    parts.some(
      (part) =>
        typeof part.metadata?.exit_code === "number" &&
        part.metadata.exit_code !== 0,
    );
  const running =
    tool.running ||
    (tool.result === undefined && !tool.interrupted && !tool.outputUnavailable);
  const commands = calls.filter((call) => call.command !== undefined).length;
  const patches = calls.filter((call) => call.patch !== undefined).length;
  const title =
    [
      commands ? plural(commands, "{n} command", "{n} commands") : "",
      patches ? plural(patches, "{n} patch", "{n} patches") : "",
    ]
      .filter(Boolean)
      .join(" · ") || t("JavaScript");
  const preview = calls
    .find((call) => call.command !== undefined)
    ?.command?.split("\n")[0];
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="my-3 min-w-0 overflow-hidden rounded-md border border-neutral-800 bg-neutral-950/40"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2 text-meta [&::-webkit-details-marker]:hidden">
        <CaretRight
          size={12}
          className="shrink-0 text-neutral-500 [[open]>summary>&]:rotate-90"
        />
        <Terminal size={16} className="shrink-0 text-neutral-400" />
        <span className="shrink-0 text-neutral-300">{title}</span>
        {preview && (
          <span
            className="fade-end min-w-0 font-mono text-neutral-500"
            title={preview}
          >
            {preview}
          </span>
        )}
        <span
          className={`ml-auto shrink-0 text-caption ${failed ? "text-red-400" : running ? "text-amber-400" : "text-neutral-500"}`}
        >
          {tool.interrupted
            ? t("Interrupted")
            : failed
              ? t("Failed")
              : running
                ? t("Running…")
                : tool.outputUnavailable
                  ? t("Output unavailable")
                  : t("Done")}
        </span>
        {tool.durationMs !== undefined && (
          <span className="shrink-0 font-mono text-caption text-neutral-600">
            {(tool.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </summary>
      {open && (
        <div className="border-t border-neutral-800">
          {calls.length ? (
            calls.map((call, i) => <CallInput key={i} call={call} />)
          ) : (
            <ExecText
              text={source ?? JSON.stringify(tool.args, null, 2) ?? ""}
              lang={source ? "javascript" : "json"}
            />
          )}
          {tool.result !== undefined && (
            <div className="border-t border-neutral-800 bg-neutral-900/30">
              <div className="px-3 pt-2 text-caption text-neutral-500">
                {t("Output")}
              </div>
              {parts.map((part, i) =>
                part.metadata ? (
                  <Metadata key={i} values={part.metadata} />
                ) : part.text.trim() ? (
                  <ExecText
                    key={i}
                    text={stripAnsi(part.text)}
                    lang={part.lang}
                  />
                ) : null,
              )}
              {!tool.result.trim() && (
                <p className="px-3 py-2 text-meta text-neutral-500">
                  {t("No output")}
                </p>
              )}
            </div>
          )}
          {children}
          <div className="space-y-2 border-t border-neutral-800 px-3 py-2 text-caption text-neutral-500">
            {source && calls.length > 0 && (
              <OriginalText
                label={t("Original JavaScript")}
                text={source}
                lang="javascript"
              />
            )}
            {tool.result !== undefined && (
              <OriginalText label={t("Raw output")} text={tool.result} />
            )}
          </div>
        </div>
      )}
    </details>
  );
});
