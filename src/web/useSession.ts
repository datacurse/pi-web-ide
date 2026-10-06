import type { Tabs } from "./tabStore.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { addNotice, ASK_ONLY } from "../shared/types.js";
import { parseActivity } from "../shared/activity.js";
import type {
  AskAnswer,
  PiAsk,
  PiEvent,
  PiImage,
  PiMessage,
  PiPartial,
  PiSessionInfo,
  Snapshot,
} from "../shared/types.js";
import { gitChanged } from "./GitActions.js";
import { groupOf, sideOfTab, withGroup } from "./tabs.js";
import type { Side } from "./tabs.js";
import { api, unwrap } from "./api.js";
import { t } from "./i18n.js";

import { commandCatalog, parseSlashCommand, WEB_COMMANDS } from "./commands.js";
import { downloadText } from "./download.js";
import { emptyPartial, reducePartial } from "../shared/partial.js";

/**
 * The server's JSON, made safe to render.
 *
 * An open browser tab holds whatever bundle it loaded for as long as it
 * stays open, and the server process outlives that bundle or predates it —
 * a long-running server still answering a freshly built client is the normal
 * state of this app during development. A field added on one side therefore
 * arrives absent on the other, and every consumer downstream trusts the
 * `Snapshot` type: one missing number becomes `undefined.toLocaleString()`
 * inside render, React unmounts the tree, and the whole app goes blank over
 * a tooltip.
 *
 * So the JSON is coerced exactly once, here, at the only place it enters
 * React state. Downstream code keeps reading non-optional fields, and a
 * skewed server costs the feature it is missing — no meter, no thinking
 * picker — instead of the window.
 */
function toSnapshot(raw: Partial<Snapshot>): Snapshot {
  return {
    ...raw,
    id: String(raw.id),
    file: typeof raw.file === "string" ? raw.file : undefined,
    // An older server sends none, and the git button simply does not appear.
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    model: typeof raw.model === "string" ? raw.model : undefined,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    partial: raw.partial ?? null,
    activity: Array.isArray(raw.activity)
      ? raw.activity.flatMap((v) => {
          const turn = parseActivity(v);
          return turn ? [turn] : [];
        })
      : [],
    isStreaming: raw.isStreaming === true,
    error: typeof raw.error === "string" ? raw.error : null,
    notices: Array.isArray(raw.notices) ? raw.notices : [],
    ask: raw.ask ?? null,
    // An older server sends none, and diff tabs show no hunk decisions.
    hunks: Array.isArray(raw.hunks) ? raw.hunks : [],
    // An older server sends none, and the picker simply has nothing to offer.
    commands: Array.isArray(raw.commands) ? raw.commands : [],
    // Absent means an older server that has no opinion; assume support
    // rather than silently disabling attachments the backend would accept.
    supportsImages: raw.supportsImages !== false,
    thinkingLevel:
      typeof raw.thinkingLevel === "string" ? raw.thinkingLevel : undefined,
    thinkingLevels: Array.isArray(raw.thinkingLevels) ? raw.thinkingLevels : [],
    contextTokens:
      typeof raw.contextTokens === "number" ? raw.contextTokens : 0,
    contextWindow:
      typeof raw.contextWindow === "number" ? raw.contextWindow : 0,
    stale: raw.stale === true,
  };
}

function preserveLiveActivity(
  fresh: Snapshot,
  current: Snapshot | null,
  baseline: Snapshot | null,
): Snapshot {
  if (!current || current.id !== fresh.id) return fresh;
  const before = new Map(
    (baseline?.id === fresh.id ? (baseline.activity ?? []) : []).map((turn) => [
      turn.start,
      turn,
    ]),
  );
  const updates = (current.activity ?? []).filter(
    (turn) => before.get(turn.start) !== turn,
  );
  if (!updates.length) return fresh;
  const turns = new Map(
    (fresh.activity ?? []).map((turn) => [turn.start, turn]),
  );
  for (const turn of updates) turns.set(turn.start, turn);
  return {
    ...fresh,
    activity: [...turns.values()].sort((a, b) => a.start - b.start),
  };
}

/**
 * What a "finished" notification says: the opening line of the answer that
 * just landed, which is the part worth reading from a desktop corner. A run
 * that ended in tool calls and no prose has nothing to quote, so it falls
 * back to saying so rather than showing an empty notification.
 */
function replyLine(snapshot: Snapshot | undefined): string {
  const message = [...(snapshot?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant");
  let text = "";
  for (const block of message?.blocks ?? []) {
    if (block.kind === "text") text = block.text;
  }
  const line =
    text
      .trim()
      .split("\n")
      .find((l) => l.trim()) ?? "";
  if (!line) return t("Finished.");
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/**
 * What a "needs you" notification says. The question itself, because that is
 * the one thing that decides whether it is worth walking back to: the agent
 * is blocked until it is answered.
 */
function askLine(ask: PiAsk): string {
  const line = (
    ask.message ||
    ask.title ||
    t("pi is waiting for an answer")
  ).trim();
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/**
 * How long a local slash command may claim to be running before the row stops
 * saying so. A command that answers nothing (`/model`, `/thinking`) emits no
 * `command_output`, so nothing else would ever stop the spinner, and
 * `/compact` on a full context legitimately takes minutes. The command itself
 * stays on screen either way — it is the record of what was sent.
 */
const COMMAND_RUNNING_MAX_MS = 120_000;
/** What a session hook needs from App: the tab strip, and the listing it keeps fresh. */
interface SessionEnv {
  side: Side;
  project: string;
  scope: string;
  tabsRef: React.MutableRefObject<Tabs>;
  commitTabs: (tabs: Tabs) => void;
  /** Close a tab in whichever column holds it: how a vanished session leaves. */
  closeRef: React.MutableRefObject<(file: string) => void>;
  refreshSessions: () => Promise<void>;
  announce: (file: string | undefined, body: string) => void;
  opened: React.MutableRefObject<Set<string>>;
  setPending: React.Dispatch<React.SetStateAction<PiSessionInfo[]>>;
}

/**
 * One attached session: its snapshot, its EventSource, its composer actions.
 *
 * Called once per editor column, so each column shows its own conversation.
 */
export function useSession({
  side,
  project,
  scope,
  tabsRef,
  commitTabs,
  closeRef,
  refreshSessions,
  announce,
  opened,
  setPending,
}: SessionEnv) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /**
   * Whether the pane is waiting for a session to open.
   *
   * `busy` is "the agent is working"; this is "there is not even a
   * transcript yet", which is a different thing to show and a different
   * thing to end.
   */
  const [opening, setOpening] = useState(false);
  /**
   * The snapshot read synchronously, because attach() has to decide whether
   * it is switching sessions or reattaching to the one on screen — and a
   * dependency on `snapshot` would rebuild the callback (and with it the
   * EventSource wiring) on every streamed delta.
   */
  const snapshotRef = useRef<Snapshot | null>(null);
  snapshotRef.current = snapshot;
  const [partial, setPartial] = useState<PiPartial>(emptyPartial);
  const [busy, setBusy] = useState(false);
  /**
   * The local slash command last sent, and whether it is still working.
   *
   * pi appends no message for a local command, so nothing in the transcript
   * records that it was sent at all; and the prompt ack is acceptance, not
   * completion — an extension command is acked at once and whatever it has
   * to say arrives later as a notification, with nothing streaming between.
   */
  const [command, setCommand] = useState<{
    text: string;
    running: boolean;
    result?: string;
  } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  /**
   * The turn error this attachment watched arrive. The server drops an error
   * once its turn has ended (`clearDeadError`), so the refetch right after
   * `idle` would wipe it off screen the moment it appeared. Kept until the
   * next send.
   */
  const seenErrorRef = useRef<string | null>(null);
  /**
   * Ticket for the newest attach. An attach whose ticket is no longer the
   * current one has been superseded by a later selection, and may not move
   * the selection or the pane; see attach().
   */
  const attachSeq = useRef(0);
  // attach() reconnects by calling itself; a useCallback cannot reference itself.
  const attachRef = useRef<(file?: string) => Promise<string | undefined>>(
    async () => undefined,
  );

  /**
   * The tab this hook is showing or opening. App's `sync` compares a
   * column's selected tab against it to decide whether to attach.
   */
  const targetRef = useRef<string | undefined>(undefined);

  /** Stop streaming and show the empty pane. Not an abort: see closeTab. */
  const detach = useCallback(() => {
    // An attach still in flight must not land in a pane that was emptied.
    attachSeq.current++;
    targetRef.current = undefined;
    esRef.current?.close();
    esRef.current = null;
    setSnapshot(null);
    setPartial(emptyPartial());
    setBusy(false);
    setModelError(null);
    // Closing the last tab is not a pending open: the pane must fall back to
    // "Select a session", not sit on "Opening session…".
    setOpening(false);
  }, []);

  /**
   * Attach to a session. The server is authoritative: we GET the full state
   * and only then start applying deltas. On any doubt we refetch rather than
   * trying to repair local state.
   */
  const attach = useCallback(
    async (file?: string) => {
      /*
       * Creating a session needs a project, and the project list arrives
       * asynchronously: pressing `+ New` before it does used to POST a blank
       * cwd, which the server resolved to its OWN directory — so the session
       * was created against a directory the user never selected. Resuming is
       * unaffected (the session header carries the cwd), so only the create
       * path waits.
       */
      if (!file && !project) return;

      /*
       * Every attach takes a ticket, and a stale ticket may not touch the
       * screen.
       *
       * Opening is slow enough to switch tabs during — so `+ New`, or a
       * click on a big session, used to land its answer seconds later and
       * yank the user out of whatever they had selected meanwhile. The
       * session itself is fine (it exists server-side and gets its tab); it
       * is the FOCUS that must not move after the user has moved it.
       */
      const seq = ++attachSeq.current;
      const superseded = () => attachSeq.current !== seq;
      targetRef.current = file;

      esRef.current?.close();
      esRef.current = null;
      setPartial(emptyPartial());
      setModelError(null);

      /*
       * Blank the pane when this attach is for a DIFFERENT session.
       *
       * Opening spawns a pi child and reads the whole transcript, so on a
       * big session it is seconds. Leaving the previous conversation on
       * screen for those seconds made a click in the session list look like
       * it had done nothing at all — the tab strip changed, the thing filling
       * the window did not. A reattach to the SAME session (an EventSource
       * that dropped, a server restart) deliberately keeps its transcript:
       * there is nothing new to wait for and blanking it would be a flicker.
       */
      const showing = snapshotRef.current;
      const same =
        showing && file && (showing.file === file || showing.id === file);
      if (!same) {
        setSnapshot(null);
        setBusy(false);
        setOpening(true);
      }

      const r = await api.sessions.open
        // Never a blank string: the server rejects that, precisely because it
        // used to mean "the server's own cwd" and silently misfiled sessions.
        .$post({ json: { file, cwd: project || undefined } })
        .catch(() => null);

      // Server unreachable (restarting, or not up yet) is TEMPORARY — keep
      // trying, and keep the tab. Only a 404 below means the session is gone.
      if (!r) {
        // "The server is restarting" resolves by waiting, so this one retries
        // — unless the user has since asked for a different session, in which
        // case retrying would eventually steal the pane back.
        if (!superseded())
          setTimeout(() => void attachRef.current(file), 1_000);
        return;
      }
      if (!r.ok) {
        if (superseded()) return;
        /*
         * Two positive answers cost this tab its slot, and nothing else
         * does: 404 means neither the registry nor the disk knows this file,
         * and 409 means the file belongs to another project — a session
         * remembered under the wrong project's key, which must not be shown
         * under the selected one. It keeps running server-side and is
         * reachable by selecting its real project. Any other status is the
         * server having a bad time, not a missing session, and must not cost
         * the user a tab.
         */
        // The retry path above keeps `opening` set, because it really is
        // still opening. This one is over: the session is gone or is not
        // this project's, and the pane goes back to its resting text.
        setOpening(false);
        if (file && (r.status === 404 || r.status === 409))
          closeRef.current(file);
        return;
      }

      const snap = toSnapshot(await r.json());

      /*
       * Open the tab from the SERVER's answer, not from the requested file:
       * `+ New` passes no file and only the response knows which session was
       * created. One code path therefore covers new sessions, list clicks and
       * restores. The id is the fallback key for a session with no file yet,
       * so two unsaved sessions cannot collide on `undefined`.
       *
       * The tab is registered even for a superseded attach — the session was
       * created, and a created session with no tab is unreachable — but it is
       * only SELECTED when this attach is still the one the user is waiting
       * for.
       */
      const key = snap.file ?? snap.id;
      opened.current.add(key);
      setPending((list) => {
        if (list.some((s) => s.path === key)) return list;
        const now = new Date().toISOString();
        return [
          ...list,
          {
            id: snap.id,
            path: key,
            created: now,
            lastActive: now,
            messageCount: 0,
            firstMessage: "",
          },
        ];
      });
      const current = tabsRef.current;
      if (current.project === scope) {
        /*
         * Which column this session's tab already lives in.
         *
         * Attaching must not ASSUME the left one. A session dragged into the
         * second column is still the attached session, and reloading the page
         * re-attaches it — which used to append a second tab for it on the
         * left, so one session showed up in both columns and the left copy
         * rendered an empty pane, because the chat can only be in one place.
         *
         * A session in NEITHER column is new: it goes where the chat already
         * is, so "+" next to a session in the second column opens beside it
         * instead of yanking the chat back to the first.
         */
        const at: Side = sideOfTab(current, key, snap.id) ?? side;
        const group = groupOf(current, at);
        // Before the commit: `sync` runs inside it and must see this tab
        // as already ours, or it would open it a second time.
        if (!superseded()) targetRef.current = key;
        // Replace a placeholder id-keyed tab once the file exists, rather
        // than ending up with two tabs for one session.
        const files = group.files.filter((f) => f !== snap.id || f === key);
        commitTabs(
          withGroup(current, at, {
            files: files.includes(key) ? files : [...files, key],
            active: superseded() ? group.active : key,
          }),
        );
      }

      /*
       * Past here is the attached state — transcript, deltas, composer — and
       * a superseded attach must claim none of it. Installing its
       * EventSource would be the worst of it: the stream of a session nobody
       * is looking at, writing into the pane of the one they are.
       */
      if (superseded()) return;

      setOpening(false);
      setSnapshot(snap);
      // A mid-stream reattach gets the in-flight message from the server, so
      // there is never a hole where streamed text should be.
      setPartial(snap.partial ?? emptyPartial());
      setBusy(snap.isStreaming);
      seenErrorRef.current = null;

      const es = new EventSource(`/api/sessions/${snap.id}/events`);
      esRef.current = es;

      /*
       * The id is a handle on a LIVE session and the server can lose it —
       * restart, crash, idle eviction. The FILE is the durable identity, so
       * reopen through it instead of leaving a tab wired to a dead id. Retry
       * on a delay because "server is down" and "server just restarted" look
       * identical from here, and only one of them resolves by waiting.
       */
      const reattach = () => {
        if (esRef.current !== es) return; // superseded by a newer attach
        es.close();
        setTimeout(() => {
          if (esRef.current === es) void attachRef.current(snap.file);
        }, 1_000);
      };

      const refetch = async (): Promise<Snapshot | undefined> => {
        const baseline = snapshotRef.current;
        const rr = await api.sessions[":id"]
          .$get({ param: { id: snap.id } })
          .catch(() => null);
        if (!rr || rr.status === 404) {
          reattach();
          return undefined;
        }
        if (!rr.ok) return undefined;
        const s = toSnapshot(await rr.json());
        if (superseded() || esRef.current !== es) return undefined;
        setSnapshot((current) =>
          preserveLiveActivity(
            { ...s, error: s.error ?? seenErrorRef.current },
            current,
            baseline,
          ),
        );
        setPartial(s.partial ?? emptyPartial());
        setBusy(s.isStreaming);
        return s;
      };

      /*
       * Did this attachment actually WATCH a run? An `idle` also arrives
       * for a session that was already finished when we attached, and
       * announcing that would mean a notification for merely opening a
       * tab. Seeded from the snapshot so a mid-stream reattach still
       * counts as watching.
       */
      let worked = snap.isStreaming;

      es.onmessage = (raw) => {
        if (superseded() || esRef.current !== es) return;
        let e: PiEvent;
        try {
          e = JSON.parse(raw.data);
        } catch {
          // A malformed frame must not kill the handler for every later event.
          void refetch();
          return;
        }
        // Clearing a completed partial waits for the authoritative message refetch.
        if (
          [
            "text",
            "thinking",
            "tool_start",
            "tool_update",
            "tool_end",
          ].includes(e.type)
        ) {
          setPartial((p) => reducePartial(p, e));
        }
        switch (e.type) {
          case "text":
            setBusy(true);
            // A command that turned into a real turn (`/review`) is no
            // longer waiting on anything — the turn itself is the answer,
            // and the transcript now shows it.
            setCommand(null);
            worked = true;
            break;
          case "thinking":
            setBusy(true);
            worked = true;
            break;
          case "tool_start":
            worked = true;
            break;
          case "tool_end":
            // Any tool may have touched the tree; re-read the changed-file count now.
            gitChanged(snap.cwd || project);
            break;
          case "message_done":
            // Refetch rather than appending: the server already settled this
            // into the session, and its copy is the one that matters.
            void refetch();
            break;
          case "activity": {
            const activity = parseActivity(e.activity);
            if (!activity) break;
            setSnapshot((s) =>
              s
                ? {
                    ...s,
                    activity: [
                      ...(s.activity ?? []).filter(
                        (turn) => turn.start !== activity.start,
                      ),
                      activity,
                    ],
                  }
                : s,
            );
            break;
          }
          case "notice":
            // Appended locally rather than refetched: the answer to a
            // command is the whole event, and a refetch of a long
            // transcript to learn one line is the wrong trade.
            setSnapshot((s) =>
              s ? { ...s, notices: addNotice(s.notices, e.notice) } : s,
            );
            // This IS the answer a local command was waiting for; the
            // command itself stays, as the record of what was asked.
            setCommand((c) => (c ? { ...c, running: false } : c));
            break;
          case "ask":
            // The agent is blocked on this until it is answered, so it is
            // also the one event worth a notification: nothing else moves
            // until the user comes back.
            setSnapshot((s) => (s ? { ...s, ask: e.ask } : s));
            if (e.ask) announce(snap.file, askLine(e.ask));
            break;
          case "idle": {
            setBusy(false);
            const shouldAnnounce = worked;
            worked = false;
            void (async () => {
              const settled = await refetch();
              if (shouldAnnounce && !superseded() && esRef.current === es)
                announce(snap.file, replyLine(settled));
            })();
            void refreshSessions();
            break;
          }
          case "error":
            setBusy(false);
            setCommand((c) => (c ? { ...c, running: false } : c));
            if (worked) {
              worked = false;
              announce(snap.file, t("Failed: {error}", { error: e.message }));
            }
            seenErrorRef.current = e.message;
            setSnapshot((s) => (s ? { ...s, error: e.message } : s));
            break;
        }
      };

      // The browser retries a dropped SSE connection on its own, but gives up
      // for good on an HTTP error — exactly what a restarted server returns for
      // an id it no longer has. CLOSED means only we can recover it.
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) reattach();
        else void refetch();
      };
      return key;
    },
    [
      refreshSessions,
      project,
      scope,
      commitTabs,
      closeRef,
      announce,
      side,
      tabsRef,
      opened,
      setPending,
    ],
  );

  attachRef.current = attach;

  useEffect(() => {
    // Fast Refresh re-runs effects: an edit to this file ran the cleanup below
    // and left the tab deaf to its session. Reopen the stream it closed.
    const file = snapshotRef.current?.file;
    if (esRef.current?.readyState === EventSource.CLOSED && file)
      void attachRef.current(file);
    return () => esRef.current?.close();
  }, []);

  // The spinner stops on its own: `/model` and friends change the session
  // without printing anything, so no answer is ever coming for them and
  // nothing else would ever take the "running" off.
  useEffect(() => {
    if (!command?.running) return;
    const t = setTimeout(
      () => setCommand((c) => (c ? { ...c, running: false } : c)),
      COMMAND_RUNNING_MAX_MS,
    );
    return () => clearTimeout(t);
  }, [command]);

  /**
   * Fold the conversation. The POST lasts the whole compaction and returns
   * once the server has re-read the folded transcript, so the refetch after
   * it is what moves the transcript and the meter. A refusal (mid-turn) is
   * shown where every other session error is.
   */
  const [compactingIds, setCompactingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const compacting = snapshot ? compactingIds.has(snapshot.id) : false;
  const compact = useCallback(
    async (instructions?: string) => {
      if (!snapshot) return;
      const seq = attachSeq.current;
      setCompactingIds((ids) => new Set(ids).add(snapshot.id));
      try {
        const r = await api.sessions[":id"].compact.$post({
          param: { id: snapshot.id },
          json: { customInstructions: instructions || undefined },
        });
        if (r.ok) {
          const fresh = await api.sessions[":id"].$get({
            param: { id: snapshot.id },
          });
          if (fresh.ok) {
            const updated = toSnapshot(await fresh.json());
            if (attachSeq.current === seq) {
              setSnapshot((s) => (s?.id === snapshot.id ? updated : s));
            }
          }
          return;
        }
        const body = await r.json().catch(() => ({}) as { error?: string });
        if (attachSeq.current === seq) {
          setSnapshot((s) =>
            s?.id === snapshot.id
              ? { ...s, error: body.error ?? t("could not compact") }
              : s,
          );
        }
      } catch (err) {
        if (attachSeq.current === seq) {
          const error = err instanceof Error ? err.message : String(err);
          setSnapshot((s) => (s?.id === snapshot.id ? { ...s, error } : s));
        }
      } finally {
        setCompactingIds((ids) => {
          const remaining = new Set(ids);
          remaining.delete(snapshot.id);
          return remaining;
        });
      }
    },
    [snapshot],
  );

  /** Every async mutation belongs to the attachment that started it, not the next selected tab. */
  const runSession = useCallback(
    async (
      action: (request: {
        id: string;
        active: () => boolean;
        update: (change: (s: Snapshot) => Snapshot) => void;
        refresh: (transform?: (s: Snapshot) => Snapshot) => Promise<void>;
      }) => Promise<void>,
      model = false,
    ) => {
      if (!snapshot) return;
      const id = snapshot.id;
      const seq = attachSeq.current;
      const active = () => attachSeq.current === seq;
      const update = (change: (s: Snapshot) => Snapshot) =>
        setSnapshot((s) => (active() && s?.id === id ? change(s) : s));
      const refresh = async (transform = (s: Snapshot) => s) => {
        const baseline = snapshotRef.current;
        const fresh = transform(
          toSnapshot(await unwrap(api.sessions[":id"].$get({ param: { id } }))),
        );
        update((current) => preserveLiveActivity(fresh, current, baseline));
      };
      if (model) setModelError(null);
      try {
        await action({ id, active, update, refresh });
      } catch (err) {
        if (!active()) return;
        const error = err instanceof Error ? err.message : String(err);
        if (model) setModelError(error);
        else update((s) => ({ ...s, error }));
      }
    },
    [snapshot],
  );

  const send = useCallback(
    async (
      text: string,
      images?: PiImage[],
      askOnly = false,
      onUiCommand?: (name: string) => Promise<void> | void,
    ) => {
      if (!snapshot) return;
      const trimmed = text.trim();
      const slash = parseSlashCommand(trimmed);
      if (slash) {
        return runSession(async ({ id, active, update, refresh }) => {
          const { name, args } = slash;
          const local = WEB_COMMANDS.some((command) => command.name === name);
          if (!local) {
            // Refresh before rejecting: newly registered extension commands are valid.
            const { commands } = await unwrap(
              api.sessions[":id"].commands.$post({ param: { id } }),
            );
            update((s) => ({ ...s, commands }));
            if (!commands.some((command) => command.name === name)) {
              throw new Error(
                `Unknown command /${name}. Type /help for available commands.`,
              );
            }
            // Registered extension commands, skills and prompts still execute in Pi.
          } else {
            if (images?.length)
              throw new Error("Browser commands do not accept attachments.");
            setCommand({ text: trimmed, running: true });
            let result = "";
            try {
              if (
                [
                  "reload",
                  "compact",
                  "name",
                  "new",
                  "tree",
                  "export",
                  "share",
                  "clone",
                  "fork",
                  "import",
                  "scoped-models",
                  "quit",
                ].includes(name) &&
                (busy || compacting || snapshot.ask)
              ) {
                throw new Error(
                  "Finish or cancel the current operation before running this command.",
                );
              }
              if (
                [
                  "reload",
                  "session",
                  "copy",
                  "settings",
                  "new",
                  "resume",
                  "help",
                  "share",
                  "clone",
                  "fork",
                  "hotkeys",
                  "changelog",
                  "quit",
                ].includes(name) &&
                args
              ) {
                throw new Error(`/${name} does not accept arguments here.`);
              }
              switch (name) {
                case "reload": {
                  const fresh = toSnapshot(
                    await unwrap(
                      api.sessions[":id"].restart.$post({ param: { id } }),
                    ),
                  );
                  if (!active()) return;
                  update(() => fresh);
                  seenErrorRef.current = null;
                  setPartial(emptyPartial());
                  setBusy(fresh.isStreaming);
                  commandsFetchedAt.current = null;
                  result =
                    "Pi restarted; extensions and configuration reloaded. Conversation preserved.";
                  break;
                }
                case "compact":
                  await compact(args || undefined);
                  return;
                case "model":
                  if (args) {
                    await unwrap(
                      api.sessions[":id"].model.$post({
                        param: { id },
                        json: { model: args },
                      }),
                    );
                    await refresh();
                  }
                  result = args
                    ? `Model set to ${args}.`
                    : `Current model: ${snapshot.model ?? "none"}. Use /model provider/model or the model selector.`;
                  break;
                case "thinking":
                  if (args) {
                    await unwrap(
                      api.sessions[":id"].thinking.$post({
                        param: { id },
                        json: { level: args },
                      }),
                    );
                    await refresh();
                  }
                  result = args
                    ? `Thinking level set to ${args}.`
                    : `Current thinking: ${snapshot.thinkingLevel ?? "none"}. Available: ${snapshot.thinkingLevels.join(", ")}.`;
                  break;
                case "name":
                  if (!args) throw new Error("Usage: /name new session title");
                  await unwrap(
                    api.sessions.rename.$post({ json: { id, name: args } }),
                  );
                  await refreshSessions();
                  await refresh();
                  result = `Session renamed to ${args}.`;
                  break;
                case "session":
                  result = `Session: ${snapshot.id}\nFile: ${snapshot.file ?? "not saved yet"}\nProject: ${snapshot.cwd}\nModel: ${snapshot.model ?? "none"}\nThinking: ${snapshot.thinkingLevel ?? "none"}\nContext: ${snapshot.contextTokens}/${snapshot.contextWindow} tokens\nMessages: ${snapshot.messages.length}`;
                  break;
                case "copy": {
                  const answer = [...snapshot.messages]
                    .reverse()
                    .find(
                      (message) =>
                        message.role === "assistant" &&
                        message.blocks.some((block) => block.kind === "text"),
                    );
                  if (!answer)
                    throw new Error("No assistant response to copy.");
                  await navigator.clipboard.writeText(
                    answer.blocks
                      .flatMap((block) =>
                        block.kind === "text" ? [block.text] : [],
                      )
                      .join("\n"),
                  );
                  result = "Last assistant response copied.";
                  break;
                }
                case "tree": {
                  const fresh = toSnapshot(
                    await unwrap(
                      api.sessions[":id"].tree.$post({
                        param: { id },
                        json: { targetId: args || undefined },
                      }),
                    ),
                  );
                  update(() => fresh);
                  setPartial(emptyPartial());
                  result =
                    "Session tree updated. Previous branches remain saved.";
                  break;
                }
                case "export": {
                  const filename =
                    args.replace(/^([\x27"])([\s\S]*)\1$/, "$2") ||
                    `session-${id}.html`;
                  const format =
                    filename === "jsonl" || filename.endsWith(".jsonl")
                      ? "jsonl"
                      : "html";
                  if (
                    args &&
                    !["html", "jsonl"].includes(args) &&
                    !/\.(html|jsonl)$/.test(filename)
                  )
                    throw new Error(
                      "Usage: /export [filename.html|filename.jsonl]",
                    );
                  const exported = await unwrap(
                    api.sessions[":id"].export.$post({
                      param: { id },
                      json: { format },
                    }),
                  );
                  downloadText(
                    exported.content,
                    exported.mime,
                    ["html", "jsonl"].includes(filename)
                      ? `session-${id}.${format}`
                      : filename,
                  );
                  result =
                    "Session downloaded. Only the active branch is exported.";
                  break;
                }
                case "share": {
                  if (
                    !window.confirm(
                      "Upload this conversation, including reasoning and tool output, to an unlisted GitHub gist? Anyone with the link can read it. Review for secrets first.",
                    )
                  )
                    return;
                  const shared = await unwrap(
                    api.sessions[":id"].share.$post({
                      param: { id },
                      json: { confirmed: true },
                    }),
                  );
                  result = `Shared session: ${shared.url}`;
                  break;
                }
                case "clone": {
                  const cloned = await unwrap(
                    api.sessions[":id"].clone.$post({ param: { id } }),
                  );
                  if (active()) await attach(cloned.file);
                  return;
                }
                case "fork": {
                  const answers = snapshot.messages.filter(
                    (message) =>
                      message.role === "assistant" &&
                      message.blocks.some((block) => block.kind === "text"),
                  );
                  if (!answers.length)
                    throw new Error("No assistant responses to fork from.");
                  const selected = window.prompt(
                    "Fork from response number:\n" +
                      answers
                        .map(
                          (answer, index) =>
                            `${index + 1}. ${answer.blocks
                              .flatMap((block) =>
                                block.kind === "text" ? [block.text] : [],
                              )
                              .join(" ")
                              .slice(0, 100)}`,
                        )
                        .join("\n"),
                    String(answers.length),
                  );
                  if (selected === null) return;
                  const index = Number(selected) - 1;
                  if (!Number.isInteger(index) || !answers[index])
                    throw new Error(
                      "Choose one of the listed response numbers.",
                    );
                  const forked = await unwrap(
                    api.sessions[":id"].fork.$post({
                      param: { id },
                      json: { at: answers[index].timestamp },
                    }),
                  );
                  if (active()) await attach(forked.file);
                  return;
                }
                case "import": {
                  const path =
                    args.replace(/^([\x27"])([\s\S]*)\1$/, "$2") ||
                    window.prompt("Pi JSONL file path within a known project:");
                  if (!path) return;
                  if (
                    !window.confirm(
                      "Import this session into a new conversation? Review untrusted session contents before running prompts.",
                    )
                  )
                    return;
                  const imported = await unwrap(
                    api.sessions[":id"].import.$post({
                      param: { id },
                      json: { path, confirmed: true },
                    }),
                  );
                  await refreshSessions();
                  if (active()) await attach(imported.file);
                  return;
                }
                case "changelog": {
                  const changelog = await unwrap(
                    api.sessions[":id"].changelog.$get({ param: { id } }),
                  );
                  downloadText(
                    changelog.content,
                    "text/markdown",
                    "pi-CHANGELOG.md",
                  );
                  result = "Installed Pi changelog downloaded.";
                  break;
                }
                case "bug": {
                  const url = new URL(
                    "https://github.com/earendil-works/pi/issues/new",
                  );
                  if (args) url.searchParams.set("title", args);
                  window.open(url.toString(), "_blank", "noopener,noreferrer");
                  result =
                    "Bug-report form opened; no conversation data was uploaded.";
                  break;
                }
                case "scoped-models": {
                  const current = await unwrap(
                    api.sessions[":id"]["scoped-models"].$get({
                      param: { id },
                    }),
                  );
                  const value =
                    args ||
                    window.prompt(
                      "Model-cycling patterns (provider/model or wildcards), separated by commas. Use all to remove scope. Saved as Pi defaults; this session will reload.",
                      current.patterns.join(", ") || "all",
                    );
                  if (value === null) return;
                  const patterns =
                    value.trim() === "all" || !value.trim()
                      ? []
                      : value.split(/[\s,]+/).filter(Boolean);
                  const fresh = toSnapshot(
                    await unwrap(
                      api.sessions[":id"]["scoped-models"].$post({
                        param: { id },
                        json: { patterns },
                      }),
                    ),
                  );
                  if (!active()) return;
                  update(() => fresh);
                  setPartial(emptyPartial());
                  commandsFetchedAt.current = null;
                  result = "Model scope saved; this session reloaded.";
                  break;
                }
                case "trust": {
                  if (args && !["on", "off", "reset"].includes(args))
                    throw new Error("Usage: /trust [on|off|reset]");
                  if (
                    args &&
                    !window.confirm(
                      `Save project trust "${args}" for ${snapshot.cwd}? This affects future Pi sessions; the current web worker already has approved project access.`,
                    )
                  )
                    return;
                  const trust = await unwrap(
                    api.sessions[":id"].trust.$post({
                      param: { id },
                      json: args
                        ? {
                            decision: args === "reset" ? null : args === "on",
                            confirmed: true,
                          }
                        : {},
                    }),
                  );
                  result = `Saved project trust: ${trust.decision === null ? "not set" : trust.decision ? "trusted" : "not trusted"}. Current web sessions retain their existing permissions.`;
                  break;
                }
                case "logout":
                  if (args) {
                    if (!window.confirm(`Log out of ${args} on this machine?`))
                      return;
                    await unwrap(
                      api.auth.logout.$post({ json: { provider: args } }),
                    );
                    result = `Logged out of ${args}. Reload sessions to pick up credential changes.`;
                  } else if (onUiCommand) await onUiCommand(name);
                  break;
                case "help":
                  result = commandCatalog(snapshot.commands)
                    .map(
                      (command) =>
                        `/${command.name} — ${command.description ?? command.source ?? ""}`,
                    )
                    .join("\n");
                  break;
                default:
                  if (!onUiCommand)
                    throw new Error("This command requires the web interface.");
                  await onUiCommand(name);
                  break;
              }
              if (active())
                setCommand({
                  text: trimmed,
                  running: false,
                  result: result || undefined,
                });
            } finally {
              if (active())
                setCommand((current) =>
                  current ? { ...current, running: false } : current,
                );
            }
            return;
          }
          // Do not recursively dispatch: this registered command goes through the ordinary prompt path.
          setCommand({ text: trimmed, running: true });
          try {
            await unwrap(
              api.sessions[":id"].prompt.$post({
                param: { id },
                json: { text: trimmed, images },
              }),
            );
          } catch (err) {
            if (active()) setCommand({ text: trimmed, running: false });
            throw err;
          }
          if (active()) await refresh();
        });
      }
      await runSession(async ({ id, active, update, refresh }) => {
        seenErrorRef.current = null;
        setBusy(true);
        setCommand(
          trimmed.startsWith("/") ? { text: trimmed, running: true } : null,
        );
        // A queued follow-up must not jump ahead of the running answer.
        const optimistic: PiMessage | null =
          !busy && !trimmed.startsWith("/")
            ? {
                role: "user",
                blocks: [
                  ...(text ? [{ kind: "text" as const, text }] : []),
                  ...(images ?? []).map((i) => ({
                    kind: "image" as const,
                    ...i,
                  })),
                ],
                timestamp: Date.now(),
              }
            : null;
        if (optimistic)
          update((s) => ({ ...s, messages: [...s.messages, optimistic] }));
        try {
          await unwrap(
            api.sessions[":id"].prompt.$post({
              param: { id },
              json: {
                text:
                  askOnly && !trimmed.startsWith("/") ? text + ASK_ONLY : text,
                images,
              },
            }),
          );
        } catch (err) {
          if (active()) {
            setBusy(busy);
            setCommand(null);
            update((s) => ({
              ...s,
              messages: s.messages.filter((m) => m !== optimistic),
            }));
          }
          throw err;
        }
        // Keep the optimistic prompt until pi has appended its own copy.
        if (active())
          await refresh((fresh) =>
            optimistic && fresh.messages.length <= snapshot.messages.length
              ? { ...fresh, messages: [...fresh.messages, optimistic] }
              : fresh,
          );
      });
    },
    [snapshot, busy, compacting, compact, runSession, refreshSessions, attach],
  );

  const abort = useCallback(
    () =>
      runSession(async ({ id }) => {
        await unwrap(api.sessions[":id"].abort.$post({ param: { id } }));
      }),
    [runSession],
  );

  /** Rewind and replace a user message; restore the transcript if the request is rejected. */
  const edit = useCallback(
    async (at: number, text: string, images?: PiImage[]) => {
      if (!snapshot || busy) return;
      await runSession(async ({ id, active, update, refresh }) => {
        setBusy(true);
        setCommand(null);
        const cut = snapshot.messages.findIndex(
          (m) => m.role === "user" && m.timestamp === at,
        );
        if (cut >= 0)
          update((s) => ({
            ...s,
            messages: [
              ...s.messages.slice(0, cut),
              {
                role: "user",
                blocks: [
                  ...(text ? [{ kind: "text" as const, text }] : []),
                  ...(images ?? []).map((i) => ({
                    kind: "image" as const,
                    ...i,
                  })),
                ],
                timestamp: Date.now(),
              },
            ],
          }));
        try {
          await unwrap(
            api.sessions[":id"].edit.$post({
              param: { id },
              json: { at, text, images },
            }),
          );
        } catch (err) {
          if (active()) {
            setBusy(false);
            update((s) => ({ ...s, messages: snapshot.messages }));
          }
          throw err;
        }
        if (active()) await refresh();
      });
    },
    [snapshot, busy, runSession],
  );

  const fork = useCallback(
    (at: number) =>
      runSession(async ({ id, active }) => {
        const body = await unwrap(
          api.sessions[":id"].fork.$post({ param: { id }, json: { at } }),
        );
        if (active()) await attach(body.file);
      }),
    [runSession, attach],
  );

  const [restartState, setRestartState] = useState<{
    id: string;
    running: boolean;
    error: string | null;
  } | null>(null);
  const restartingIds = useRef(new Set<string>());
  const restarting = Boolean(
    restartState && restartState.id === snapshot?.id && restartState.running,
  );
  const restartError =
    restartState?.id === snapshot?.id ? restartState?.error : null;
  const restart = useCallback(
    () =>
      runSession(async ({ id, active, update }) => {
        if (restartingIds.current.has(id)) return;
        restartingIds.current.add(id);
        setRestartState({ id, running: true, error: null });
        try {
          const fresh = toSnapshot(
            await unwrap(api.sessions[":id"].restart.$post({ param: { id } })),
          );
          update(() => fresh);
          if (active()) {
            seenErrorRef.current = null;
            setPartial(emptyPartial());
            setBusy(fresh.isStreaming);
            setCommand(null);
            commandsFetchedAt.current = null;
          }
        } catch (err) {
          if (active())
            setRestartState({
              id,
              running: false,
              error: err instanceof Error ? err.message : String(err),
            });
        } finally {
          restartingIds.current.delete(id);
          setRestartState((state) =>
            state?.id === id ? { ...state, running: false } : state,
          );
        }
      }),
    [runSession],
  );

  /** Refresh facts that change outside the event stream, such as installed packages. */
  const reloadSnapshot = useCallback(
    () => runSession(async ({ refresh }) => refresh()),
    [runSession],
  );

  /** The slash-command catalog is per session and cached for half a minute. */
  const commandsFetchedAt = useRef<{ id: string; at: number } | null>(null);
  const refreshCommands = useCallback(
    () =>
      runSession(async ({ id, update }) => {
        const last = commandsFetchedAt.current;
        if (last && last.id === id && Date.now() - last.at < 30_000) return;
        commandsFetchedAt.current = { id, at: Date.now() };
        try {
          const { commands } = await unwrap(
            api.sessions[":id"].commands.$post({ param: { id } }),
          );
          update((s) => ({ ...s, commands }));
        } catch {
          if (commandsFetchedAt.current?.id === id)
            commandsFetchedAt.current = null;
        }
      }),
    [runSession],
  );

  /** A stale question gets a 409; refetch it rather than answering a different one. */
  const answerAsk = useCallback(
    (askId: string, answer: AskAnswer) =>
      runSession(async ({ id, active, update, refresh }) => {
        update((s) => ({ ...s, ask: null }));
        try {
          const r = await api.sessions[":id"].ask.$post({
            param: { id },
            json: { askId, ...answer },
          });
          if (r.status === 409) {
            if (active()) await refresh();
          } else await unwrap(r);
        } catch (err) {
          update((s) => ({ ...s, ask: snapshot?.ask ?? null }));
          throw err;
        }
      }),
    [runSession, snapshot],
  );

  const changeModel = useCallback(
    (model: string) =>
      runSession(async ({ id, active, refresh }) => {
        await unwrap(
          api.sessions[":id"].model.$post({ param: { id }, json: { model } }),
        );
        if (active()) await refresh();
      }, true),
    [runSession],
  );

  const changeThinking = useCallback(
    (level: string) =>
      runSession(async ({ id, active, refresh }) => {
        await unwrap(
          api.sessions[":id"].thinking.$post({
            param: { id },
            json: { level },
          }),
        );
        if (active()) await refresh();
      }, true),
    [runSession],
  );

  const changeFast = useCallback(
    (enabled: boolean) =>
      runSession(async ({ id, active, refresh }) => {
        await unwrap(
          api.sessions[":id"].fast.$post({ param: { id }, json: { enabled } }),
        );
        if (active()) await refresh();
      }, true),
    [runSession],
  );

  return {
    snapshot,
    partial,
    busy,
    opening,
    command,
    modelError,
    targetRef,
    attach,
    detach,
    send,
    abort,
    compact,
    compacting,
    fork,
    edit,
    restart,
    restarting,
    restartError,
    reloadSnapshot,
    refreshCommands,
    answerAsk,
    changeModel,
    changeThinking,
    changeFast,
  };
}
