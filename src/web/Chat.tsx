import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  ArrowDown,
  CaretRight,
  Check,
  PaperPlaneTilt,
  Paperclip,
  QuestionMark,
  Square,
} from "@phosphor-icons/react";
import type {
  AskAnswer,
  PiCommand,
  PiImage,
  PiPartial,
  Snapshot,
} from "../shared/types.js";
import { Button, ContextMenu, IconButton, MenuItem } from "./ui.js";
import { mergeLiveTools } from "../shared/toolTree.js";
import { ModelSelector } from "./ModelSelector.js";
import { GitActions } from "./GitActions.js";
import { RawBlocks } from "./RawOutput.js";
import { WorkTimeline } from "./WorkTimeline.js";
import { rawRows, type RawRow } from "./rawTurns.js";
import { ASK_MODES, type AskMode, type UserMode } from "./prefs.js";
import {
  clearDraft,
  readDraft,
  writeDraftImages,
  writeDraftText,
} from "./drafts.js";
import {
  completionOptions,
  parseCompletion,
  type CommandOption,
} from "./commands.js";
import { AskPanel } from "./AskPanel.js";
import { OverlayScrollbar } from "./OverlayScrollbar.js";
import {
  Attachments,
  Lightbox,
  SUPPORTED_IMAGE_MIME,
  ZoomContext,
  readImage,
  uploadFile,
} from "./Attachments.js";
import type { ImageWorkspace } from "./imageAnnotations.js";
import {
  AnswerActions,
  CommandRow,
  ContextMeter,
  ContextPanel,
  UserMessage,
  Notices,
  NoticeText,
} from "./Transcript.js";
import { formatDuration, t } from "./i18n.js";
import { PiMark } from "./piMark.js";
import { PastedTexts } from "./PastedTexts.js";
import {
  addPastedText,
  isLargePaste,
  joinPastedText,
  splitPastedText,
} from "./pastedText.js";

/** pi's `get_commands` omits its TUI-only `/compact`; `send` in useSession.ts runs it. */
const COMPACT_COMMAND: PiCommand = {
  name: "compact",
  get description() {
    return t(
      "Summarise older messages to free context (optional: focus instructions)",
    );
  },
  source: "pwi",
};

/**
 * How far from the bottom still counts as "at the bottom" — see `pinned` in
 * Chat. One line's worth: enough to absorb fractional device pixels and a
 * smooth scroll settling a pixel short, small enough that scrolling up to read
 * anything at all counts as having left.
 */
const PINNED_SLACK_PX = 24;

/**
 * The slash-command picker, above the composer.
 *
 * Not a dialog: the CLI shows this list without taking the keyboard away, and
 * that is the whole point — you keep typing and the list narrows. A modal
 * would mean tabbing out of the box you are completing, and would put a
 * backdrop over the transcript you are writing about.
 *
 * Mouse-down rather than click to pick: click fires after blur, and the
 * composer losing focus mid-pick puts the caret nowhere.
 */
function CommandPicker({
  options,
  selected,
  onPick,
  onHover,
}: {
  options: CommandOption[];
  selected: number;
  onPick: (option: CommandOption) => void;
  onHover: (index: number) => void;
}) {
  const list = useRef<HTMLDivElement>(null);

  // Keyboard navigation has to drag the viewport with it, or arrowing past
  // the fold selects rows nobody can see. 45 commands is well past the fold.
  useEffect(() => {
    list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={list}
      role="listbox"
      aria-label={t("Slash commands")}
      className="mb-2 max-h-64 overflow-y-auto rounded-sm border border-neutral-700 bg-neutral-900"
    >
      {options.map((o, i) => (
        <div
          key={o.insert}
          role="option"
          aria-selected={i === selected}
          onMouseMove={() => onHover(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(o);
          }}
          className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-ui ${
            i === selected ? "bg-neutral-800" : ""
          }`}
        >
          <span className="font-mono text-neutral-100">{o.label}</span>
          {o.source && (
            <span className="font-mono text-meta text-neutral-500">
              {o.source}
            </span>
          )}
          {o.description && (
            <span className="fade-end text-meta text-neutral-400">
              {o.description}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const HistoryRow = memo(function HistoryRow({
  row,
  expanded,
  onToggle,
  userMode,
  onEdit,
  onFork,
}: {
  row: RawRow;
  expanded: boolean;
  onToggle: () => void;
  userMode: UserMode;
  onEdit?: (at: number, text: string, images: PiImage[]) => void;
  onFork: (at: number) => Promise<void>;
}) {
  if (row.role === "user")
    return (
      <UserMessage
        blocks={row.blocks}
        at={row.at}
        userMode={userMode}
        onEdit={onEdit}
      />
    );
  const durationMs =
    row.workStartedAt !== undefined && row.workEndedAt !== undefined
      ? row.workEndedAt - row.workStartedAt
      : undefined;
  const workLabel =
    (durationMs === undefined
      ? t("Worked")
      : t("Worked for {duration}", { duration: formatDuration(durationMs) })) +
    (row.roundtrips === undefined
      ? ""
      : t(row.roundtrips === 1 ? ", {n} roundtrip" : ", {n} roundtrips", {
          n: row.roundtrips,
        }));
  return (
    <div className="chat-gutter my-3">
      <div className="chat-measure">
        {row.role !== "assistant" && (
          <div className="font-mono text-meta text-neutral-500">{row.role}</div>
        )}
        {(!!row.work?.length || row.running) && (
          <>
            {!row.running && (
              <button
                type="button"
                data-custom="work disclosure: muted status text without button chrome"
                aria-expanded={expanded}
                onClick={onToggle}
                className="group/work chat-prose inline-flex items-center gap-1.5 py-1 text-neutral-500 transition-colors hover:text-neutral-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500"
              >
                {workLabel}
                <CaretRight
                  size={12}
                  aria-hidden
                  className={`transition-opacity ${expanded ? "rotate-90 opacity-100" : "opacity-0 group-hover/work:opacity-100 group-focus-visible/work:opacity-100"}`}
                />
              </button>
            )}
            {(row.running || expanded) && (
              <WorkTimeline
                blocks={row.work ?? []}
                activity={row.activity}
                running={row.running}
                expanded={expanded}
              />
            )}
          </>
        )}
        <RawBlocks blocks={row.blocks} />
        {row.answerAt !== undefined && (
          <AnswerActions
            at={row.answerAt}
            respondedAt={row.workEndedAt ?? row.answerAt}
            durationMs={
              row.workStartedAt !== undefined && row.workEndedAt !== undefined
                ? Math.max(0, row.workEndedAt - row.workStartedAt)
                : undefined
            }
            text={row.blocks
              .flatMap((b) => (b.kind === "text" ? [b.text] : []))
              .join("\n\n")}
            onFork={onFork}
          />
        )}
      </div>
    </div>
  );
});

/** Page-wide: with two columns, only the first composer to show takes the load focus. */
let focusedOnLoad = false;

export function Chat({
  snapshot,
  partial,
  busy,
  opening,
  userMode,
  onEdit,
  onFork,
  askMode,
  onAskMode,
  modelError,
  command,
  onAnswerAsk,
  onSend,
  onAbort,
  onModelChange,
  onThinkingChange,
  onFastChange,
  onCommandMenu,
  onCompact,
  compacting,
  onRestart,
  restarting,
  restartError,
  draftRev = 0,
  focus,
}: {
  snapshot: Snapshot | null;
  partial: PiPartial;
  busy: boolean;
  /**
   * A session is being opened and there is nothing to show yet. Separate
   * from `busy` (which is "the agent is working"): this one means the
   * transcript itself has not arrived.
   */
  opening: boolean;
  /** How long user messages fold; see prefs.ts. */
  userMode: UserMode;
  /** Whether Ask only switches off after a send; see prefs.ts. */
  askMode: AskMode;
  onAskMode: (mode: AskMode) => void;
  modelError?: string | null;
  /**
   * The local slash command last sent, verbatim, and whether it is still
   * working. pi appends no message for one, so this is the only record of
   * it on screen; see useSession.ts for its lifetime.
   */
  command?: { text: string; running: boolean } | null;
  onSend: (text: string, images?: PiImage[], askOnly?: boolean) => void;
  onAnswerAsk: (askId: string, answer: AskAnswer) => void;
  onAbort: () => void;
  onModelChange: (model: string) => void;
  onThinkingChange: (level: string) => void;
  onFastChange: (enabled: boolean) => Promise<void>;
  /** The composer's `/` picker just opened; re-read the command catalog. */
  onCommandMenu: () => void;
  /** Fold the conversation into a summary. Refused while a turn is running. */
  onCompact: (instructions?: string) => void;
  /** A compaction started here is running. */
  compacting: boolean;
  /** Open a new session that continues from the answer that started at `at`. */
  onFork: (at: number) => Promise<void>;
  /** Replace the user message that started at `at` and ask again from there. */
  onEdit: (at: number, text: string, images: PiImage[]) => void;
  /** Replace this session's pi child so it sees newly installed packages. */
  onRestart: () => void;
  restarting: boolean;
  restartError?: string | null;
  /**
   * Bumped when App wrote this session's draft (Explorer's "Add to Chat"):
   * re-read it and put the caret at its end.
   */
  draftRev?: number;
  /** Bumped when a session is selected: focus the composer once it shows. */
  focus?: { entry: string; n: number };
}) {
  const [text, setText] = useState("");
  const pasted = useMemo(() => splitPastedText(text), [text]);
  // In "toggle" mode sticky until switched off or the session changes; "once" clears it on send.
  const [askOnly, setAskOnly] = useState(false);
  /** The Ask only button's right-click menu position, or null when shut. */
  const [askMenu, setAskMenu] = useState<{ x: number; y: number } | null>(null);
  const [images, setImages] = useState<PiImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  /** The expanded attachment, as a data URL, or null. See Lightbox. */
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [imageWorkspaces, setImageWorkspaces] = useState<
    Record<string, ImageWorkspace>
  >({});
  const [contextOpen, setContextOpen] = useState(false);
  const closeContext = useCallback(() => setContextOpen(false), []);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const attachViewport = useCallback((element: HTMLDivElement | null) => {
    viewport.current = element;
    setScrollParent(element);
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * The staged images, readable synchronously. A paste is async (the blob has
   * to be read), so two fast pastes both need the list as it is right now —
   * and persisting a draft from inside a state updater would make the write a
   * side effect of rendering.
   */
  const staged = useRef<PiImage[]>([]);
  /**
   * Whether the transcript is parked at its bottom, which is what decides
   * whether new content scrolls the view. Slack because "at the bottom" is
   * never exact: fractional device pixels, a smooth scroll settling a pixel
   * short, and a reader who nudged the wheel once all still mean "bottom".
   */
  const pinned = useRef(true);
  /**
   * The same fact as `pinned`, in state rather than a ref, because the
   * "jump to latest" button has to RENDER from it. `pinned` stays a ref: it
   * is read inside the scroll handler on every frame of a stream, and a
   * re-render per scroll event would cost more than the button is worth.
   */
  const [atBottom, setAtBottom] = useState(true);
  const toBottom = () => {
    const el = viewport.current;
    if (!el) return;
    pinned.current = true;
    setAtBottom(true);
    el.scrollTop = el.scrollHeight;
  };
  /**
   * Picker state. `selected` is an index into the current option list, and
   * `dismissed` remembers an Escape: the panel must stay shut while the user
   * finishes typing the command they already know the name of, and reopen
   * only when the text changes again.
   */
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);

  // Normalised in toSnapshot (useSession.ts), so this is a plain boolean even against a
  // server too old to send it.
  const canAttach = snapshot?.supportsImages;

  /*
   * Restore the composer for the session being shown — see drafts.ts. This is
   * the ONLY place `text` and `images` are set from outside a user action, so
   * a tab switch swaps composers and a reload lands on what was typed.
   */
  const draftKey = snapshot?.id;
  const seenRev = useRef(draftRev);
  const seenKey = useRef(draftKey);
  useEffect(() => {
    if (!draftKey) return;
    const draft = readDraft(draftKey);
    setText(draft.text);
    const sameSession = seenKey.current === draftKey;
    seenKey.current = draftKey;
    // An insert, not a session switch: the rest of the composer stays.
    if (sameSession && draftRev !== seenRev.current) {
      seenRev.current = draftRev;
      if (draftRev === 0) return;
      const el = composer.current;
      el?.focus();
      el?.setSelectionRange(draft.text.length, draft.text.length);
      return;
    }
    seenRev.current = draftRev;
    setImages(draft.images);
    staged.current = draft.images;
    setZoomed(null);
    setImageWorkspaces({});
    setAttachError(null);
    setAskOnly(false);
  }, [draftKey, draftRev]);

  // A reload lands in the composer, unless something else already took focus.
  useEffect(() => {
    if (focusedOnLoad || !draftKey || !composer.current) return;
    focusedOnLoad = true;
    if (document.activeElement === document.body) composer.current.focus();
  }, [draftKey]);

  const seenFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focus || !snapshot || focus.n === seenFocus.current) return;
    if (focus.entry !== snapshot.file && focus.entry !== snapshot.id) return;
    seenFocus.current = focus.n;
    composer.current?.focus();
  }, [focus, snapshot]);

  /*
   * The picker's contents, derived from the text rather than held in state:
   * one source of truth means the panel cannot disagree with the box it is
   * completing, and there is no open/close bookkeeping to get wrong.
   */
  const completion = useMemo(
    () => (pasted.attachments.length ? null : parseCompletion(pasted.text)),
    [pasted],
  );
  const options = useMemo(
    () =>
      completion
        ? completionOptions(
            [COMPACT_COMMAND, ...(snapshot?.commands ?? [])],
            completion,
          )
        : [],
    [completion, snapshot?.commands],
  );
  const pickerOpen = options.length > 0 && !dismissed;

  // A changed option list makes the old index meaningless — and keeping it
  // would accept a row the user never looked at.
  useEffect(() => setSelected(0), [text]);

  /*
   * The moment the composer becomes a command word is the moment to ask the
   * session what commands it has. Keyed on `completing` rather than on the
   * text, so holding a `/` and typing a name is one request, not one per
   * keystroke; the server-side half is cached for 30s on top of that.
   */
  const completing = completion !== null;
  useEffect(() => {
    if (completing) onCommandMenu();
  }, [completing, onCommandMenu]);

  /*
   * Follow the stream only while the reader is already AT the bottom.
   *
   * Scrolling up is how you read back through a run that is still going, and
   * yanking the view down on every delta made that impossible: the transcript
   * grows several times a second, so every attempt to inspect an earlier tool
   * call was undone before it could be read. Being parked at the bottom is
   * the only state in which "keep me at the bottom" is what the reader asked
   * for.
   *
   * Tracked from the scroll event rather than measured here, because by the
   * time this effect runs the new content has already grown the scroll height
   * and the reader is no longer at the bottom by definition. The last scroll
   * the USER made is the intent worth reading.
   *
   * The jump is instant, and that is what keeps the flag honest. A scroll
   * event cannot say who caused it, so a SMOOTH follow un-pins itself: text
   * arrives faster than the animation travels, the handler sees a gap well
   * short of the bottom, reads it as the reader scrolling away, and following
   * stops mid-stream. Landing exactly at the bottom means the event our own
   * scroll produces re-states "still pinned" instead of contradicting it.
   */
  useEffect(() => {
    // A different session opens at its latest turn, and resets the intent:
    // the previous one may well have been left scrolled up.
    pinned.current = true;
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snapshot?.id]);

  useEffect(() => {
    const el = viewport.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [snapshot?.messages.length, partial.text, partial.thinking]);

  useEffect(() => {
    const el = viewport.current;
    const body = content.current;
    if (!el || !body) return;
    const resize = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    resize.observe(body);
    return () => resize.disconnect();
  }, [snapshot?.id, scrollParent]);

  /**
   * A call settles into the transcript with the message that made it, then
   * shows up in `partial.tools` once it starts running. Rendering both drew
   * the call twice and bumped the fold's count by one until its result
   * settled. So a live call's output goes onto its settled row, and only
   * calls not yet in the transcript stay in the partial.
   */
  const { messages, liveTools } = useMemo(() => {
    const settled = snapshot?.messages ?? [];
    if (partial.tools.length === 0)
      return { messages: settled, liveTools: partial.tools };
    return mergeLiveTools(settled, partial.tools);
  }, [snapshot?.messages, partial.tools]);

  const [expandedWork, setExpandedWork] = useState<Set<string>>(
    () => new Set(),
  );
  const rows = useMemo(
    () =>
      rawRows(
        messages,
        { ...partial, tools: liveTools },
        busy,
        snapshot?.activity,
      ),
    [messages, partial, liveTools, busy, snapshot?.activity],
  );

  if (!snapshot) {
    return (
      <main className="flex flex-1 items-center justify-center text-ui text-neutral-500">
        {/*
				  Opening a session spawns a pi child and reads the whole
				  transcript, which on a big session or a Pi is seconds. Showing the
				  old session's messages while that happens made a click look like
				  it did nothing, so the pane blanks immediately and says what it is
				  waiting for.

				  The label fades in rather than appearing at once: a cached session
				  opens in tens of milliseconds, and a spinner that flashes for one
				  frame is worse than no spinner. CSS, not a timer, because this is
				  presentation and a state update per open is not.
				*/}
        {opening ? (
          <span className="opening-label">{t("Opening session…")}</span>
        ) : (
          t("Select a session, or press + New.")
        )}
      </main>
    );
  }

  /*
   * Every composer mutation goes through these two, which keep the persisted
   * draft in step with the state. Writing from an effect instead would race
   * the restore above: on a tab switch the effect would run with the new
   * session's key and the previous session's text, and copy one onto the
   * other.
   */
  const changeText = (value: string) => {
    setText(value);
    writeDraftText(snapshot.id, value);
    // Typing is a new question, so a dismissed picker gets another chance:
    // Escape hides the list for the text it was showing, not forever.
    setDismissed(false);
  };

  /**
   * Take a row. The whole composer is the command being completed, so the
   * option replaces all of it — and accepting always leaves a trailing
   * space, which is what turns `/fast` into the state that offers `on`,
   * `off`, `status`.
   */
  const changeVisibleText = (value: string) =>
    changeText(joinPastedText(value, pasted.attachments));
  const accept = (option: CommandOption) => {
    changeVisibleText(option.insert);
    composer.current?.focus();
  };
  /** False when the attachments are staged but too big to persist as a draft. */
  const changeImages = (next: PiImage[]): boolean => {
    staged.current = next;
    setImages(next);
    return writeDraftImages(snapshot.id, next);
  };

  /**
   * Ingest files from a paste, a drop or the file picker.
   *
   * Supported images are staged as attachments. Anything else is uploaded to
   * the pwi machine and its path goes into the message, because the browser
   * may be on another machine than pi and a local path would mean nothing.
   */
  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const isImage = (f: File) => SUPPORTED_IMAGE_MIME.includes(f.type);
    if (!canAttach && files.some(isImage)) {
      setAttachError(
        t("This model does not accept images. Switch models to attach one."),
      );
      return;
    }

    const accepted = files.filter(isImage);
    const others = files.filter((f) => !isImage(f));

    try {
      const paths = await Promise.all(others.map((f) => uploadFile(f)));
      if (paths.length > 0) {
        const current = composer.current?.value ?? pasted.text;
        const sep = current && !current.endsWith("\n") ? "\n" : "";
        changeVisibleText(current + sep + paths.join("\n"));
      }
      const read = await Promise.all(accepted.map(readImage));
      const kept =
        read.length === 0 || changeImages([...staged.current, ...read]);
      /*
       * Both are worth saying, and neither is fatal: the rejected types were
       * dropped, and images that did not fit in storage are still attached
       * and still send — they just will not come back after a reload, which
       * is better said than silently promised.
       */
      setAttachError(
        kept ? null : t("Attached, but too large to keep if the page reloads."),
      );
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = () => {
    const t = text.trim();
    // An image on its own is a valid prompt; only block when nothing is staged.
    if (!t && images.length === 0) return;
    onSend(
      pasted.attachments.length ? text : t,
      images.length > 0 ? images : undefined,
      askOnly,
    );
    if (askMode === "once") setAskOnly(false);
    setText("");
    setImages([]);
    staged.current = [];
    clearDraft(snapshot.id);
    setAttachError(null);
  };

  const hasPartial = Boolean(
    partial.text || partial.thinking || liveTools.length,
  );

  return (
    /*
     * `min-h-0` twice, and it is load-bearing: a flex item defaults to
     * `min-height: auto`, so without it this column grows to fit the whole
     * transcript instead of being clipped to the panel, the inner
     * `overflow-y-auto` never has anything to scroll, and the DOCUMENT
     * scrolls instead — taking the session list and the composer with it.
     */
    <ZoomContext.Provider
      value={(src) =>
        setZoomed(
          Object.entries(imageWorkspaces).find(
            ([, workspace]) => workspace.exportedSrc === src,
          )?.[0] ?? src,
        )
      }
    >
      <main className="flex min-h-0 flex-1 flex-col">
        {/* The rows own their top spacing; the last one needs a floor under
			    it, and the scroll container is the only thing that knows which
			    row that is. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={attachViewport}
            onClickCapture={(e) => {
              if (
                e.target instanceof Element &&
                e.target.closest('[data-custom="inline timing disclosure"]')
              ) {
                pinned.current = false;
                setAtBottom(false);
              }
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              const bottom =
                el.scrollHeight - el.scrollTop - el.clientHeight <=
                PINNED_SLACK_PX;
              pinned.current = bottom;
              // Only on a CHANGE: the setter is called for every scroll event
              // otherwise, which React would coalesce but still has to diff.
              setAtBottom((was) => (was === bottom ? was : bottom));
            }}
            style={{ overflowAnchor: "none" }}
            className="no-scrollbar fade-bottom min-h-0 flex-1 overflow-y-auto pb-[max(3rem,var(--chat-scroll-past,0px))]"
          >
            {snapshot.messages.length === 0 &&
              !hasPartial &&
              !busy &&
              !command && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center select-none">
                  <PiMark className="text-display size-[1em] text-amber-400" />
                  <div className="text-title text-neutral-200">
                    {t("New session")}
                  </div>
                  <div className="text-ui text-neutral-500">
                    {t("in")}{" "}
                    <span className="font-mono text-neutral-400">
                      {snapshot.cwd.split(/[\\/]/).filter(Boolean).at(-1) ??
                        snapshot.cwd}
                    </span>
                    {" · "}
                    {t("type")}{" "}
                    <kbd className="font-mono text-neutral-400">/</kbd>{" "}
                    {t("for commands")}
                  </div>
                </div>
              )}
            <div ref={content}>
              {scrollParent && rows.length > 0 && (
                <Virtuoso
                  key={snapshot.id}
                  customScrollParent={scrollParent}
                  data={rows}
                  initialTopMostItemIndex={rows.length - 1}
                  increaseViewportBy={200}
                  computeItemKey={(i, row) => `${row.role}:${row.at}:${i}`}
                  itemContent={(_i, row) => {
                    const key = `${snapshot.id}:${row.role}:${row.at}`;
                    return (
                      <div className="flow-root">
                        <HistoryRow
                          row={row}
                          userMode={userMode}
                          onEdit={busy ? undefined : onEdit}
                          onFork={onFork}
                          expanded={expandedWork.has(key)}
                          onToggle={() =>
                            setExpandedWork((previous) => {
                              const next = new Set(previous);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        />
                      </div>
                    );
                  }}
                />
              )}

              {/* Below the transcript: a local command answers after the last
				    message, and before the next prompt clears it. */}
              {command && (
                <CommandRow command={command.text} running={command.running} />
              )}

              <Notices notices={snapshot.notices} />

              {/* Last, under the work that led to it: the agent is stopped here
				    until this is answered. Keyed so a second question does not
				    inherit the first one's typed draft. */}
              {snapshot.ask && (
                <AskPanel
                  key={snapshot.ask.id}
                  ask={snapshot.ask}
                  onAnswer={onAnswerAsk}
                />
              )}

              {/* Errors are visible in the chat, never only in stderr. */}
              {snapshot.error && (
                <div className="chat-gutter my-3">
                  <div className="chat-measure rounded-sm border border-red-900 bg-red-950/40 px-3 py-2 text-body text-red-300">
                    <NoticeText text={snapshot.error} />
                  </div>
                </div>
              )}
            </div>
          </div>
          <OverlayScrollbar target={viewport} />
        </div>

        {/*
         * Git sits in the READING column, not the wide track, and no rule
         * separates it from the transcript: the composer is the bottom of
         * the chat, not a panel docked under it. A border here drew exactly
         * that second panel. The context meter lives inside the composer.
         */}
        <div data-no-column-menu className="chat-gutter relative -mt-3 pb-6">
          {/* Same column as the prose above it, so the box's edges line up
					    with the text you are replying to. */}
          <div className="chat-measure relative">
            {/* Outside the virtual transcript: never overlaps a measured row. */}
            {snapshot.stale && (
              <div className="mb-3 rounded-sm border border-neutral-800 bg-neutral-900 px-3 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="text-ui text-neutral-200">
                      {t("Package updates available")}
                    </div>
                    <div className="mt-1 text-meta text-neutral-500">
                      {busy
                        ? t("Finish the current turn before restarting.")
                        : t(
                            "Restart to load updated commands and skills. Your conversation is kept.",
                          )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={onRestart}
                    disabled={busy || compacting || restarting}
                  >
                    {restarting ? t("Restarting…") : t("Restart session")}
                  </Button>
                </div>
                {restartError && (
                  <div role="alert" className="mt-2 text-meta text-red-400">
                    {restartError}
                  </div>
                )}
              </div>
            )}
            {/*
             * Git on the right of the status line and ABOVE the composer,
             * which is where it belongs in the flow: you finish reading the
             * turn, then you commit it. `onDone` refetches nothing here —
             * the button owns its own state — but a commit does change the
             * transcript's context, so the caller gets a hook.
             */}
            <div className="absolute -right-3 bottom-full mb-2 flex items-center gap-2">
              {/* Jump to the newest message. Only while scrolled away from it:
						    a button that does nothing is worse than no button. */}
              {!atBottom && (
                <IconButton
                  onClick={toBottom}
                  label={t("Jump to the latest message")}
                  variant="outline"
                  round
                >
                  <ArrowDown size={14} />
                </IconButton>
              )}
              {snapshot.cwd && <GitActions cwd={snapshot.cwd} />}
            </div>
            {contextOpen && (
              <ContextPanel
                sessionId={snapshot.id}
                tokens={snapshot.contextTokens}
                window={snapshot.contextWindow}
                busy={busy}
                onCompact={onCompact}
                onClose={closeContext}
              />
            )}
            {pickerOpen && (
              <CommandPicker
                options={options}
                selected={selected}
                onPick={accept}
                onHover={setSelected}
              />
            )}

            {/*
             * One box, the way every current chat client draws it: staged
             * attachments on top, the field under them, and the controls on a
             * bottom row inside the same border — attach and the model on the
             * left, send on the right. The thumbnails used to sit ABOVE the
             * box and the model selector above that, which read as three
             * widgets that happened to be adjacent rather than as one thing
             * you are about to send.
             */}
            <div className="-mx-3 rounded-lg bg-neutral-900 p-3 ring-1 ring-neutral-700 ring-inset">
              <PastedTexts
                key={draftKey}
                items={pasted.attachments}
                onChange={(items) =>
                  changeText(joinPastedText(pasted.text, items))
                }
              />
              <Attachments
                images={images}
                onRemove={(i) =>
                  void changeImages(images.filter((_, n) => n !== i))
                }
              />

              {Object.entries(imageWorkspaces)
                .filter(
                  ([, workspace]) =>
                    workspace.exportedSrc &&
                    images.some(
                      (image) =>
                        `data:${image.mimeType};base64,${image.data}` ===
                        workspace.exportedSrc,
                    ),
                )
                .map(([src, workspace]) => (
                  <Button
                    key={src}
                    size="sm"
                    variant="subtle"
                    className="mb-2 mr-2"
                    onClick={() => setZoomed(src)}
                  >
                    {t("Annotated image · {n} marks", {
                      n: workspace.exportedCount ?? 0,
                    })}
                  </Button>
                ))}

              {attachError && (
                <div className="mb-2 text-meta text-red-400">{attachError}</div>
              )}

              <textarea
                data-custom="composer"
                ref={composer}
                value={pasted.text}
                onChange={(e) => changeVisibleText(e.target.value)}
                /*
                 * Ctrl+V never reaches onKeyDown as an intercept point worth using:
                 * clipboard contents are only available on the paste event itself
                 * (and reading them any other way needs a permission prompt). So we
                 * listen for paste, which also covers Cmd+V, middle-click paste and
                 * the context menu for free.
                 *
                 * Small text pastes keep the browser's normal insertion behavior.
                 */
                onPaste={(e) => {
                  const files = Array.from(e.clipboardData.files);
                  if (files.length > 0) {
                    e.preventDefault();
                    void addFiles(files);
                    return;
                  }
                  const value = e.clipboardData.getData("text/plain");
                  if (!isLargePaste(value)) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const caret = el.selectionStart;
                  changeText(
                    addPastedText(text, value, caret, el.selectionEnd),
                  );
                  requestAnimationFrame(() =>
                    el.setSelectionRange(caret, caret),
                  );
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const files = Array.from(e.dataTransfer.files);
                  if (files.length === 0) return;
                  e.preventDefault();
                  void addFiles(files);
                }}
                onKeyDown={(e) => {
                  /*
                   * The picker owns these keys while it is open, and only then:
                   * Enter takes the highlighted command instead of sending the
                   * half-typed name, Tab completes, Escape hides the list. The
                   * arrows move the highlight rather than the caret, which is
                   * free — the text is one line by the time the picker is up.
                   */
                  if (pickerOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSelected((s) => (s + 1) % options.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSelected(
                        (s) => (s - 1 + options.length) % options.length,
                      );
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setDismissed(true);
                      return;
                    }
                    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                      e.preventDefault();
                      const option = options[selected];
                      /*
                       * The name is already typed in full and the row would
                       * only add its trailing space: `/compact` + Enter has to
                       * RUN `/compact`, not cost a second Enter. Tab still
                       * completes, which is how you get to the subcommands.
                       */
                      if (e.key === "Enter" && option?.insert === `${text} `) {
                        submit();
                        return;
                      }
                      if (option) accept(option);
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                // `rows` is the fallback; where `field-sizing: content` is
                // supported the box starts at one line and grows to max-h-60.
                rows={2}
                placeholder={t("Message pi…")}
                title={
                  canAttach
                    ? t(
                        "Enter to send, Shift+Enter for newline, Ctrl+V to paste a screenshot",
                      )
                    : t("Enter to send, Shift+Enter for newline")
                }
                // Transparent and borderless: the BOX is the control now, and a
                // second inset panel inside it was two edges for one field.
                className="chat-prose field-sizing-content max-h-60 w-full resize-none bg-transparent outline-none placeholder:text-neutral-600"
              />

              {/* Attach, context and the model on the left, send on the right. */}
              <div className="mt-4 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <IconButton
                    onClick={() => fileInput.current?.click()}
                    label={t("Attach a file")}
                    variant="bare"
                    size="sm"
                    round
                  >
                    <Paperclip size={24} />
                  </IconButton>
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      // Reset so picking the SAME file twice still fires onChange.
                      e.target.value = "";
                      void addFiles(files);
                    }}
                  />
                  <ContextMeter
                    tokens={snapshot.contextTokens}
                    window={snapshot.contextWindow}
                    compacting={compacting}
                    open={contextOpen}
                    onToggle={() => setContextOpen((o) => !o)}
                  />
                  <ModelSelector
                    model={snapshot.model}
                    disabled={busy}
                    error={modelError}
                    onChange={onModelChange}
                    thinkingLevel={snapshot.thinkingLevel}
                    thinkingLevels={snapshot.thinkingLevels}
                    thinkingLevelMap={snapshot.thinkingLevelMap}
                    onThinkingChange={onThinkingChange}
                    fastMode={snapshot.fastMode}
                    onFastChange={onFastChange}
                  />
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {busy && (
                    <IconButton
                      onClick={onAbort}
                      label={t("Stop")}
                      title={t("Stop this turn")}
                      size="sm"
                      variant="outline"
                      round
                    >
                      <Square size={10} weight="fill" />
                    </IconButton>
                  )}
                  <IconButton
                    onClick={() => setAskOnly((a) => !a)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setAskMenu({ x: e.clientX, y: e.clientY });
                    }}
                    label={
                      askOnly
                        ? t("Ask only: on (no code changes)")
                        : t("Ask only: off")
                    }
                    aria-pressed={askOnly}
                    variant="bare"
                    size="sm"
                    round
                  >
                    <QuestionMark
                      size={24}
                      weight={askOnly ? "bold" : "regular"}
                      className={askOnly ? "text-amber-400" : undefined}
                    />
                  </IconButton>
                  {askMenu && (
                    <ContextMenu
                      x={askMenu.x}
                      y={askMenu.y}
                      label={t("Ask only button")}
                      onClose={() => setAskMenu(null)}
                    >
                      {ASK_MODES.map((m) => (
                        <MenuItem
                          key={m.id}
                          role="menuitemradio"
                          aria-checked={m.id === askMode}
                          title={t(m.hint)}
                          icon={
                            m.id === askMode ? <Check size={16} /> : <span />
                          }
                          onClick={() => {
                            onAskMode(m.id);
                            setAskMenu(null);
                          }}
                        >
                          {t(m.label)}
                        </MenuItem>
                      ))}
                    </ContextMenu>
                  )}
                  <IconButton
                    onClick={submit}
                    disabled={!text.trim() && images.length === 0}
                    label={t("Send")}
                    title={t("Send (Enter)")}
                    variant="bare"
                    size="sm"
                    round
                  >
                    <PaperPlaneTilt
                      size={24}
                      className={
                        !text.trim() && images.length === 0
                          ? undefined
                          : "text-neutral-100"
                      }
                    />
                  </IconButton>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Last, so it paints over everything: an expanded attachment. */}
        {zoomed && (
          <Lightbox
            key={zoomed}
            src={zoomed}
            above={composer}
            workspace={imageWorkspaces[zoomed] ?? { marks: [], nextId: 1 }}
            onChange={(workspace) =>
              setImageWorkspaces((old) => ({ ...old, [zoomed]: workspace }))
            }
            onAdd={(image, previousSrc, reference) => {
              if (!canAttach) {
                setAttachError(
                  t(
                    "This model does not accept images. Switch models to attach one.",
                  ),
                );
                return false;
              }
              const index = staged.current.findIndex((item) => {
                const src = `data:${item.mimeType};base64,${item.data}`;
                return src === zoomed || src === previousSrc;
              });
              const next = [...staged.current];
              if (index < 0) next.push(image);
              else next[index] = image;
              const kept = changeImages(next);
              setAttachError(
                kept
                  ? null
                  : t("Attached, but too large to keep if the page reloads."),
              );
              const current = composer.current?.value ?? pasted.text;
              changeVisibleText(
                `${current}${current && !current.endsWith("\n") ? "\n" : ""}[Image ${index < 0 ? next.length : index + 1}] ${reference}`,
              );
              composer.current?.focus();
              return true;
            }}
            onClose={() => setZoomed(null)}
          />
        )}
      </main>
    </ZoomContext.Provider>
  );
}
