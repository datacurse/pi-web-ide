import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  CaretDown,
  CaretRight,
  CaretUp,
  Check,
  Copy,
  GitFork,
  PaperPlaneTilt,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import type {
  ContextBreakdown,
  ContextItem,
  ContextPart,
  PiBlock,
  PiImage,
  PiNotice,
} from "../shared/types.js";
import { AutoGoalNotice, isAutoGoalText } from "./AutoGoalNotice.js";
import { api, unwrap } from "./api.js";
import { Button, IconButton, ListRow } from "./ui.js";
import { timeAgo } from "./SessionList.js";
import { Attachments, Thumb } from "./Attachments.js";
import { t, plural, locale } from "./i18n.js";
import type { UserMode } from "./prefs.js";
import { PastedTexts } from "./PastedTexts.js";
import { RawBlocks } from "./RawOutput.js";
import { ResponseTime } from "./ResponseTime.js";
import {
  addPastedText,
  isLargePaste,
  joinPastedText,
  splitPastedText,
} from "./pastedText.js";

/** Braille spinner, same visual language as the TUI. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STAR_FRAMES = ["·", "✢", "∗", "✶", "✻", "✽", "✻", "✶", "∗", "✢"];

function useSpinner(active: boolean, frames = SPINNER_FRAMES, ms = 80): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setI((v) => (v + 1) % frames.length), ms);
    return () => clearInterval(id);
  }, [active, frames, ms]);
  return frames[i % frames.length];
}

/**
 * A user message clamped to 3 lines so a long prompt does not bury the
 * transcript. The toggle shows only when the clamp actually cuts text.
 */
function UserText({ text, mode }: { text: string; mode: UserMode }) {
  const pasted = splitPastedText(text);
  if (pasted.attachments.length)
    return (
      <>
        <PastedTexts items={pasted.attachments} />
        {pasted.text && <PlainUserText text={pasted.text} mode={mode} />}
      </>
    );
  return <PlainUserText text={text} mode={mode} />;
}

function PlainUserText({ text, mode }: { text: string; mode: UserMode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(mode !== "clamped");
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || mode === "full") return;
    // Against 3 lines, not clientHeight, so it also holds while open.
    const check = () =>
      setOverflows(
        el.scrollHeight > 3 * parseFloat(getComputedStyle(el).lineHeight) + 1,
      );
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, mode]);
  if (mode === "full") return <div className="whitespace-pre-wrap">{text}</div>;
  return (
    <>
      <div
        ref={ref}
        className={`whitespace-pre-wrap ${open || !overflows ? "" : "fade-clamp"}`}
      >
        {text}
      </div>
      {overflows && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 -ml-2"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <CaretUp size={12} /> : <CaretDown size={12} />}
          {open ? t("Show less") : t("Show more")}
        </Button>
      )}
    </>
  );
}

/** 24_200 -> "24.2K". */
function popupTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * How full the context is, as a ring in the composer, drawn empty before the
 * first turn rather than hidden. Clicking it opens `ContextPanel`.
 *
 * The number is pi's own `contextUsage` from `get_session_stats` (see
 * `fetchState` in src/server/agent.ts), not an estimate: it already counts
 * the system prompt, the tools and the cached prefix, and unlike the newest
 * turn's `usage` it follows a compaction back down. It goes amber at 75% and
 * red at 90%, the band where the next long tool result triggers a compaction.
 */
export function ContextMeter({
  tokens,
  window: limit,
  compacting,
  open,
  onToggle,
}: {
  tokens: number;
  window: number;
  compacting: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  if (compacting) return <Compacting />;
  const share = limit > 0 ? Math.min(1, tokens / limit) : 0;
  const tone =
    share >= 0.9
      ? "text-red-400"
      : share >= 0.75
        ? "text-amber-400"
        : "text-neutral-400";
  const label =
    limit > 0
      ? t("Context: {pct}% full ({tokens} of {limit} tokens)", {
          pct: Math.round(share * 100),
          tokens: tokens.toLocaleString(locale()),
          limit: limit.toLocaleString(locale()),
        })
      : t("Context usage");
  return (
    <IconButton
      label={label}
      onClick={onToggle}
      aria-expanded={open}
      data-context-meter
      round
      size="sm"
    >
      <Ring share={share} stroke={1.5} className={`size-7 shrink-0 ${tone}`} />
    </IconButton>
  );
}

/** A progress ring, empty at 0. `currentColor` fills it, `neutral-700` is the track. */
function Ring({
  share,
  className,
  stroke = 2,
}: {
  share: number;
  className: string;
  stroke?: number;
}) {
  const r = 7 - stroke / 2;
  const around = 2 * Math.PI * r;
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`-rotate-90 ${className}`}>
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth={stroke}
        className="stroke-neutral-700"
      />
      {share > 0 && (
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          strokeWidth={stroke}
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(share * around, 0.5)} ${around}`}
        />
      )}
    </svg>
  );
}

const PARTS: Record<ContextPart["key"], { label: string; color: string }> = {
  system: { label: "System prompt", color: "bg-ctx-system" },
  tools: { label: "Tool definitions", color: "bg-ctx-tools" },
  rules: { label: "Rules", color: "bg-ctx-rules" },
  skills: { label: "Skills", color: "bg-ctx-skills" },
  personality: { label: "Personality", color: "bg-ctx-personality" },
  conversation: { label: "Conversation", color: "bg-ctx-conversation" },
};

function percentText(share: number): string {
  return share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** A conversation item's name and count, as the popup shows them. `sub`: a tool's program or file. */
function itemLabel(
  key: ContextPart["key"],
  item: ContextItem,
  sub = false,
): { name: string; detail?: string; mono: boolean } {
  const tool = sub || (key === "conversation" && item.name.startsWith("tool:"));
  const n = item.count ?? 0;
  const detail = !n
    ? undefined
    : tool
      ? plural(n, "{n} call", "{n} calls")
      : String(n);
  return {
    name: tool && !sub ? item.name.slice(5) : item.name,
    detail,
    mono: tool || key === "tools" || key === "skills",
  };
}

/**
 * What fills the context, above the composer, like Cursor's. The total is the
 * meter's (pi's real count); the parts are pi's chars/4 estimates from
 * context-extension.ts, with the conversation's pieces scaled to fill what
 * the fixed parts leave of the total. Every part opens into its pieces; the
 * largest starts open. Compacting lives here now that a click on the meter
 * opens this.
 */
export function ContextPanel({
  sessionId,
  tokens,
  window: limit,
  busy,
  onCompact,
  onClose,
}: {
  sessionId: string;
  tokens: number;
  window: number;
  busy: boolean;
  onCompact: () => void;
  onClose: () => void;
}) {
  const [parts, setParts] = useState<ContextBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    unwrap(api.sessions[":id"].context.$get({ param: { id: sessionId } })).then(
      (b) => {
        if (!live) return;
        setParts(b);
        const top = b.reduce<ContextPart | undefined>(
          (m, p) => (!m || p.tokens > m.tokens ? p : m),
          undefined,
        );
        if (top?.items?.length) setOpen(new Set([top.key]));
      },
      (err: unknown) =>
        live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  // It floats over the transcript, so it may grow up to the top of the chat.
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const fit = () => {
      const el = box.current;
      const chat = el?.closest("main");
      if (el?.parentElement && chat)
        setRoom(
          el.parentElement.getBoundingClientRect().top -
            chat.getBoundingClientRect().top -
            16,
        );
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Escape or a click anywhere else closes it; the meter's own click toggles.
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!box.current?.contains(t) && !t.closest?.("[data-context-meter]"))
        onClose();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("pointerdown", down);
    };
  }, [onClose]);

  // The conversation is what pi's total leaves after the fixed parts.
  const fixed = (parts ?? [])
    .filter((p) => p.key !== "conversation")
    .reduce((n, p) => n + p.tokens, 0);
  const talk = parts?.find((p) => p.key === "conversation");
  const talkReal =
    tokens > 0 ? Math.max(0, tokens - fixed) : (talk?.tokens ?? 0);
  const scale = talk && talk.tokens > 0 ? talkReal / talk.tokens : 0;
  const scaled = (i: ContextItem): ContextItem => ({
    ...i,
    tokens: Math.round(i.tokens * scale),
    items: i.items?.map(scaled),
  });
  const rows = (parts ?? [])
    .map((p) =>
      p.key === "conversation"
        ? { ...p, tokens: talkReal, items: p.items?.map(scaled) }
        : p,
    )
    .filter((p) => p.tokens > 0);
  const total = parts ? Math.max(tokens, fixed + talkReal) : tokens;
  const share = limit > 0 ? Math.min(1, total / limit) : 0;
  const tone =
    share >= 0.9
      ? "text-red-400"
      : share >= 0.75
        ? "text-amber-400"
        : "text-(--ct-teal)";
  const largest = rows
    .flatMap((p) =>
      p.items?.length ? p.items.map((i) => ({ key: p.key, item: i })) : [],
    )
    .reduce<{ key: ContextPart["key"]; item: ContextItem } | undefined>(
      (m, x) => (!m || x.item.tokens > m.item.tokens ? x : m),
      undefined,
    );

  const expandable = rows.flatMap((p) => [
    ...(p.items?.some((i) => i.tokens > 0) ? [p.key] : []),
    ...(p.items ?? [])
      .filter((i) => i.items?.some((s) => s.tokens > 0))
      .map((i) => `${p.key}/${i.name}`),
  ]);
  /** A piece's row; a tool whose calls split by program or file opens into them. */
  const itemRow = (
    key: ContextPart["key"],
    i: ContextItem,
    of: number,
    id: string,
    sub = false,
  ): ReactNode => {
    const l = itemLabel(key, i, sub);
    const subs = i.items?.filter((s) => s.tokens > 0) ?? [];
    const expanded = open.has(id);
    const cells = (
      <>
        {subs.length > 0 && (
          <span aria-hidden className="w-3 shrink-0 text-neutral-500">
            {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </span>
        )}
        <span className={`min-w-0 fade-end ${l.mono ? "font-mono" : ""}`}>
          {l.name}
        </span>
        {l.detail && (
          <span className="shrink-0 text-neutral-500">{l.detail}</span>
        )}
        <span
          aria-hidden
          className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-neutral-800"
        >
          <span
            className={`block h-full ${PARTS[key].color}`}
            style={{ width: `${(i.tokens / of) * 100}%` }}
          />
        </span>
        <span className="w-10 text-right tabular-nums text-neutral-500">
          {percentText(i.tokens / total)}
        </span>
        <span className="w-12 text-right tabular-nums">
          {popupTokens(i.tokens)}
        </span>
      </>
    );
    // A caret sits left of the name, so the name lines up with its siblings'.
    const indent = sub ? "pl-16" : subs.length > 0 ? "pl-7" : "pl-12";
    const row = `flex w-full items-center gap-2 py-0.5 pr-3 text-left text-meta text-neutral-400 ${indent}`;
    return (
      <div key={id}>
        {subs.length > 0 ? (
          <button
            data-custom="transcript disclosure"
            title={i.name}
            aria-expanded={expanded}
            onClick={() => toggle(id)}
            className={`${row} hover:bg-neutral-800`}
          >
            {cells}
          </button>
        ) : (
          <div title={i.name} className={row}>
            {cells}
          </div>
        )}
        {expanded &&
          subs.map((s) => itemRow(key, s, i.tokens, `${id}/${s.name}`, true))}
      </div>
    );
  };
  const allOpen = expandable.length > 0 && expandable.every((k) => open.has(k));
  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (!n.delete(key)) n.add(key);
      return n;
    });

  return (
    <div
      ref={box}
      style={{ maxHeight: room }}
      className="absolute inset-x-0 bottom-full z-10 mb-2 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 py-2"
    >
      <div className="flex items-center justify-between px-3 text-neutral-300">
        {t("Context Usage")}
        <div className="flex items-center gap-1">
          {expandable.length > 0 && (
            <IconButton
              label={allOpen ? t("Collapse all") : t("Expand all")}
              size="sm"
              onClick={() => setOpen(new Set(allOpen ? [] : expandable))}
            >
              {allOpen ? (
                <ArrowsInLineVertical size={14} />
              ) : (
                <ArrowsOutLineVertical size={14} />
              )}
            </IconButton>
          )}
          <IconButton label={t("Close")} size="sm" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-3 px-3">
        <div className="relative flex shrink-0 items-center justify-center">
          <Ring share={share} stroke={1.5} className={`size-14 ${tone}`} />
          <span className="absolute text-meta font-semibold tabular-nums text-neutral-100">
            {limit > 0 ? percentText(share) : "?"}
          </span>
        </div>
        <div className="min-w-0 tabular-nums">
          <div>
            <span className="text-title text-neutral-100">
              ~{popupTokens(total)}
            </span>
            <span className="text-neutral-400">
              {" "}
              / {limit > 0 ? popupTokens(limit) : "?"} {t("tokens")}
            </span>
          </div>
          <div className="text-meta text-neutral-500">
            {limit > 0 &&
              t("{n} free", { n: popupTokens(Math.max(0, limit - total)) })}
            {largest && total > 0 && (
              <>
                {` · ${t("largest:")} `}
                <span className="text-neutral-300">
                  {itemLabel(largest.key, largest.item).name}
                </span>
                {` (${percentText(largest.item.tokens / total)})`}
              </>
            )}
          </div>
        </div>
      </div>

      {/* What the used part is made of, full width so small parts still show. */}
      <div className="mx-3 mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full">
        {total > 0 &&
          rows.map((p) => (
            <span
              key={p.key}
              title={`${t(PARTS[p.key].label)}: ${popupTokens(p.tokens)}`}
              className={`min-w-0.5 rounded-full ${PARTS[p.key].color}`}
              style={{ width: `${(p.tokens / total) * 100}%` }}
            />
          ))}
      </div>

      {error ? (
        <div className="mt-2 px-3 text-meta text-red-400">{error}</div>
      ) : !parts ? (
        <div className="mt-2 px-3 text-meta text-neutral-500">
          {t("Measuring…")}
        </div>
      ) : (
        <div className="mt-2">
          {rows.map((p) => {
            const items = p.items?.filter((i) => i.tokens > 0) ?? [];
            const expanded = open.has(p.key);
            return (
              <div key={p.key}>
                <ListRow
                  onClick={() => items.length > 0 && toggle(p.key)}
                  aria-expanded={items.length > 0 ? expanded : undefined}
                  className="gap-2"
                >
                  <span aria-hidden className="w-3 text-neutral-500">
                    {items.length > 0 &&
                      (expanded ? (
                        <CaretDown size={12} />
                      ) : (
                        <CaretRight size={12} />
                      ))}
                  </span>
                  <span
                    aria-hidden
                    className={`size-3 shrink-0 rounded-sm ${PARTS[p.key].color}`}
                  />
                  <span className="text-neutral-200">
                    {t(PARTS[p.key].label)}
                  </span>
                  {items.length > 0 && (
                    <span className="text-meta text-neutral-500">
                      {items.length}
                    </span>
                  )}
                  <span className="ml-auto w-10 text-right text-meta tabular-nums text-neutral-500">
                    {percentText(p.tokens / total)}
                  </span>
                  <span className="w-12 text-right tabular-nums text-neutral-300">
                    {popupTokens(p.tokens)}
                  </span>
                </ListRow>
                {expanded &&
                  items.map((i) =>
                    itemRow(p.key, i, p.tokens, `${p.key}/${i.name}`),
                  )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between gap-3 px-3">
        <span className="text-meta text-neutral-500">
          {t(
            "The total is pi's count; parts are estimates (about 4 characters a token).",
          )}
        </span>
        <Button
          size="sm"
          disabled={busy || tokens <= 0}
          title={
            busy
              ? t("Finish the turn to compact")
              : t("Fold the conversation into a summary")
          }
          onClick={() => {
            onClose();
            onCompact();
          }}
        >
          {t("Compact")}
        </Button>
      </div>
    </div>
  );
}

/** The meter while a compaction runs: the turn's spinner, which is JS-driven so reduced motion does not freeze it. */
function Compacting() {
  const spinner = useSpinner(true, STAR_FRAMES, 120);
  const [start] = useState(Date.now);
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      data-custom="context meter"
      role="status"
      className="flex shrink-0 items-center gap-1.5 px-1 text-meta tabular-nums text-neutral-400"
    >
      <span aria-hidden className="w-3 text-center text-amber-400">
        {spinner}
      </span>
      {t("compacting {time}", { time: elapsed(now - start) })}
    </span>
  );
}

/** 75000 -> "1m 15s". */
function elapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  return secs < 60
    ? t("{s}s", { s: secs })
    : t("{m}m {s}s", { m: Math.floor(secs / 60), s: secs % 60 });
}

/** Copy `text`; the icon swaps to a check for 1.2s. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can be denied/unavailable; failing silently beats a crash.
    }
  };
  return (
    <IconButton
      size="sm"
      label={copied ? t("Copied") : t("Copy")}
      onClick={() => void copy()}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}

/**
 * Under your prompt: copy it, edit it (disabled while a turn runs), and when it
 * was sent. The answer footer's shape, with Edit in Fork's place.
 */
function UserFooter({
  text,
  at,
  onEdit,
}: {
  text: string;
  at?: number;
  onEdit?: () => void;
}) {
  return (
    <div className="chat-measure mt-1 flex items-center gap-1 text-meta text-neutral-500">
      <CopyButton text={text} />
      <IconButton
        size="sm"
        label={t("Edit")}
        disabled={!onEdit}
        onClick={onEdit}
      >
        <PencilSimple size={14} />
      </IconButton>
      {at !== undefined && (
        <span
          className="msg-footer-time ml-1"
          title={new Date(at).toLocaleString(locale())}
        >
          {timeAgo(at)}
        </span>
      )}
    </div>
  );
}

/**
 * The line between one turn and the next, above your prompt, across the whole
 * pane (outside the gutter). Kept but invisible above the first prompt, so its
 * spacing stays.
 */
function TurnSeparator({ first }: { first: boolean }) {
  return (
    <hr
      aria-hidden
      className={`turn-separator my-6 border-neutral-800 ${first ? "hidden" : ""}`}
    />
  );
}

/**
 * A user message being edited, in the pill's place, drawn as the composer:
 * the same box, field and send button, plus Cancel. Sending drops everything
 * after it and asks again with the attachments that are left.
 */
function EditMessage({
  text,
  attached,
  first,
  onCancel,
  onSend,
}: {
  text: string;
  attached: PiImage[];
  first: boolean;
  onCancel: () => void;
  onSend: (text: string, images: PiImage[]) => void;
}) {
  const [draft, setDraft] = useState(text);
  const pasted = splitPastedText(draft);
  const [images, setImages] = useState(attached);
  const canSend = draft.trim() !== "" || images.length > 0;
  return (
    <div className={first ? "pt-6" : undefined}>
      <TurnSeparator first={first} />
      <div className="chat-gutter">
        <div className="chat-measure">
          <div className="-mx-3 rounded-lg bg-neutral-900 p-3 ring-1 ring-neutral-700 ring-inset">
            <PastedTexts
              items={pasted.attachments}
              onChange={(items) => setDraft(joinPastedText(pasted.text, items))}
            />
            <Attachments
              images={images}
              onRemove={(i) => setImages(images.filter((_, n) => n !== i))}
            />
            <textarea
              data-custom="composer"
              autoFocus
              value={pasted.text}
              onChange={(e) =>
                setDraft(joinPastedText(e.target.value, pasted.attachments))
              }
              onPaste={(e) => {
                const value = e.clipboardData.getData("text/plain");
                if (!isLargePaste(value)) return;
                e.preventDefault();
                setDraft(
                  addPastedText(
                    draft,
                    value,
                    e.currentTarget.selectionStart,
                    e.currentTarget.selectionEnd,
                  ),
                );
              }}
              onFocus={(e) =>
                e.currentTarget.setSelectionRange(
                  pasted.text.length,
                  pasted.text.length,
                )
              }
              onKeyDown={(e) => {
                if (e.key === "Escape") onCancel();
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (canSend) onSend(draft, images);
                }
              }}
              placeholder={t("Message pi…")}
              title={t(
                "Enter to send, Shift+Enter for newline, Escape to cancel",
              )}
              className="chat-prose field-sizing-content max-h-60 w-full resize-none bg-transparent outline-none placeholder:text-neutral-600"
            />
            <div className="mt-4 flex items-center justify-end gap-1.5">
              <Button size="sm" onClick={onCancel}>
                {t("Cancel")}
              </Button>
              <IconButton
                onClick={() => onSend(draft, images)}
                disabled={!canSend}
                label={t("Send")}
                title={t("Send (Enter)")}
                variant="bare"
                size="sm"
                round
              >
                <PaperPlaneTilt
                  size={24}
                  className={canSend ? "text-neutral-100" : undefined}
                />
              </IconButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Per-level colors for a notice line. Info is deliberately quiet. */
const NOTICE_STYLE: Record<PiNotice["level"], string> = {
  info: "border-neutral-800 bg-neutral-900/60 text-neutral-300",
  warning: "border-amber-900 bg-amber-950/30 text-amber-300",
  error: "border-red-900 bg-red-950/40 text-red-300",
};

/**
 * What a local slash command answered.
 *
 * `/compact`, `/cost` and friends never append a message, so this is the
 * whole visible result of running one: without it a command looks like it did
 * nothing at all. Ephemeral by design — the next prompt clears it.
 */
export function NoticeText({ text }: { text: string }) {
  if (!/^(Project|Session) notebook checkpoint failed:/.test(text))
    return <>{text}</>;
  return (
    <>
      <div className="font-medium">{t("Agent memory could not be saved")}</div>
      <div className="mt-1 text-body">
        {t(
          "This affects saved working memory, not files already edited. The agent may need to rebuild that memory after a restart.",
        )}
      </div>
      <details
        data-custom="notebook warning technical details"
        className="mt-2 text-meta"
      >
        <summary
          data-custom="notebook warning disclosure"
          className="cursor-pointer"
        >
          {t("Technical details")}
        </summary>
        <div className="mt-2 font-mono whitespace-pre-wrap break-words">
          {text}
        </div>
      </details>
    </>
  );
}

export function Notices({ notices }: { notices: PiNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="chat-gutter my-3 space-y-2">
      {notices.map((n, i) =>
        isAutoGoalText(n.text) ? (
          <div key={i} className="chat-measure">
            <AutoGoalNotice text={n.text} />
          </div>
        ) : (
          <div
            key={i}
            className={`chat-measure rounded-sm border px-3 py-2 text-body whitespace-pre-wrap break-words ${NOTICE_STYLE[n.level]}`}
          >
            <NoticeText text={n.text} />
          </div>
        ),
      )}
    </div>
  );
}

/**
 * A local slash command, echoed as the user row pi never writes.
 *
 * Two separate gaps, one row: a local command appends NO message, so the
 * `/compact remote` you typed vanished from the transcript the moment the box
 * cleared; and the prompt ack is acceptance and not completion, so nothing
 * said it was still going either. Ephemeral like the notice it belongs to —
 * the next prompt clears both.
 */
export function CommandRow({
  command,
  running,
  first,
}: {
  command: string;
  running: boolean;
  first: boolean;
}) {
  const spinner = useSpinner(running);
  return (
    <UserRow first={first}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-body">{command}</span>
        {running && (
          <span className="flex items-center gap-1.5 font-mono text-meta text-amber-400">
            <span>{spinner}</span>
            <span className="font-sans">{t("working…")}</span>
          </span>
        )}
      </div>
    </UserRow>
  );
}

/** User prompts retain their pill, attachments, copy button and inline editing. */
function UserRow({
  children,
  below,
  first,
}: {
  children: ReactNode;
  below?: ReactNode;
  first: boolean;
}) {
  return (
    <div className={first ? "pt-6" : undefined}>
      <TurnSeparator first={first} />
      <div className="chat-gutter">
        <div className="chat-measure">
          <div className="-mx-3 chat-prose rounded-lg bg-neutral-900 p-3 ring-1 ring-neutral-700 ring-inset">
            {children}
          </div>
        </div>
        {below}
      </div>
    </div>
  );
}

export function UserMessage({
  blocks,
  userMode,
  first,
  at,
  onEdit,
}: {
  blocks: PiBlock[];
  userMode: UserMode;
  first: boolean;
  at?: number;
  onEdit?: (at: number, text: string, images: PiImage[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const images = blocks.filter((b) => b.kind === "image");
  const text = blocks
    .flatMap((b) => (b.kind === "text" ? [b.text] : []))
    .join("\n\n");
  if (editing && onEdit && at !== undefined)
    return (
      <EditMessage
        text={text}
        first={first}
        attached={images.map(({ data, mimeType }) => ({ data, mimeType }))}
        onCancel={() => setEditing(false)}
        onSend={(next, kept) => {
          setEditing(false);
          onEdit(at, next, kept);
        }}
      />
    );
  return (
    <UserRow
      first={first}
      below={
        <UserFooter
          text={text}
          at={at}
          onEdit={
            onEdit && at !== undefined ? () => setEditing(true) : undefined
          }
        />
      }
    >
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((image, i) => (
            <Thumb
              key={i}
              image={image}
              label={t("attachment {n}", { n: i + 1 })}
            />
          ))}
        </div>
      )}
      {blocks.map((block, i) =>
        block.kind === "image" ? null : block.kind === "text" ? (
          <UserText key={i + userMode} text={block.text} mode={userMode} />
        ) : (
          <RawBlocks key={i} blocks={[block]} />
        ),
      )}
    </UserRow>
  );
}

/** Actions target the final assistant message, never the prompt that grouped the turn. */
export function AnswerActions({
  text,
  at,
  respondedAt = at,
  durationMs,
  onFork,
}: {
  text: string;
  at: number;
  respondedAt?: number;
  durationMs?: number;
  onFork: (at: number) => Promise<void>;
}) {
  const [forking, setForking] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-1 text-meta text-neutral-500">
      <CopyButton text={text} />
      <IconButton
        size="sm"
        label={forking ? t("Forking…") : t("Fork from here")}
        disabled={forking}
        onClick={() => {
          setForking(true);
          void onFork(at).finally(() => setForking(false));
        }}
      >
        <GitFork size={14} />
      </IconButton>
      <ResponseTime at={respondedAt} durationMs={durationMs} />
    </div>
  );
}
