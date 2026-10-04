import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { useSession } from "./useSession.js";
import { startPointerDrag } from "./pointerDrag.js";
import { sessionPrompts } from "./sessionName.js";
import { EditorColumn } from "./EditorColumn.js";
import {
  FileNavigationContext,
  fileLocation,
  type FileLocation,
} from "./fileNavigation.js";
import {
  LAST_PROJECT_KEY,
  pinWindowProject,
  readTabs,
  readWindowProject,
  writeStored,
  type Tabs,
} from "./tabStore.js";
import type { PiSessionInfo } from "../shared/types.js";
import type { Hunk } from "../shared/hunks.js";
import { SessionList } from "./SessionList.js";
import { SessionSearch } from "./SessionSearch.js";
import { CommandPalette, type PaletteCommand } from "./CommandPalette.js";
import { WorkoutCard } from "./Workout.js";
import { ProjectPicker, type Projects } from "./ProjectPicker.js";
import { ActivityBar } from "./ActivityBar.js";
import { Stats } from "./Stats.js";
import { Fleet } from "./Fleet.js";
import { Chat } from "./Chat.js";
import { TerminalPane } from "./Terminal.js";
import { SourceControl } from "./SourceControl.js";
import { GIT_CHANGED } from "./GitActions.js";
import { Explorer } from "./Explorer.js";
import { readDraft, writeDraftText } from "./drafts.js";
import { joinPastedText, splitPastedText } from "./pastedText.js";
import {
  afterPathChange,
  collapse,
  diffTab,
  fileTab,
  groupOf,
  isFileTab,
  isTermTab,
  termId,
  termTab,
  isSessionTab,
  moveTab,
  pinnedFirst,
  sideOfTab,
  tabPath,
  withGroup,
  withoutTab,
  withTab,
} from "./tabs.js";
import type { Side } from "./tabs.js";
import { PageDialog, type PageId } from "./PageDialog.js";
import { Themes } from "./Themes.js";
import {
  EMPTY_LAYOUT,
  addTab,
  allTerminals,
  reconcile,
  type TermLayout,
} from "./termLayout.js";
import { Settings } from "./Settings.js";
import { Packages } from "./Packages.js";
import {
  applyChatFade,
  applyFooterLayout,
  applyHideScrollbars,
  applyScrollPast,
  applySessionLines,
  applyTheme,
  THEMES,
  readDockHeight,
  readDockOpen,
  readChatFade,
  readFooterLayout,
  readSessionLines,
  readSessionAttachments,
  writeSessionAttachments,
  readHideScrollbars,
  readNotify,
  readScrollPast,
  readScrollPastOn,
  readPanel,
  readPinnedSessions,
  readSeenSessions,
  readSessionSort,
  readLatestPrompt,
  readTerminalLayout,
  readTerminalWidth,
  readListWidth,
  clampListWidth,
  LIST_MIN_PX,
  LIST_MAX_PX,
  writeListWidth,
  readEditorTheme,
  readTheme,
  readUserMode,
  readAskMode,
  TERMINAL_MAX_PERCENT,
  TERMINAL_MIN_PERCENT,
  PANEL_MIN_PERCENT,
  writeDockHeight,
  writeDockOpen,
  writeNotify,
  writePanel,
  writePinnedSessions,
  writeSeenSessions,
  writeSessionSort,
  writeLatestPrompt,
  writeTerminalLayout,
  writeTerminalWidth,
  writeUserMode,
  writeAskMode,
  type Panel,
  type SessionSort,
  type ThemeId,
  type UserMode,
  type AskMode,
} from "./prefs.js";
import {
  matchShortcut,
  readBindings,
  recorder,
  shortcutKeys,
  type ShortcutId,
} from "./shortcuts.js";
import { setFavicon } from "./favicon.js";
import {
  attentionOf,
  attentionTitle,
  nextWaiting,
  type Attention,
} from "./attention.js";
import { Button, hoverIntent, IconButton, PanelHeader } from "./ui.js";
import { api, unwrap } from "./api.js";
import { t } from "./i18n.js";

/**
 * The stand-in for "no session, so no hunks".
 *
 * A module constant and not `[]` inline: a fresh array on every render is a
 * new prop identity, which would re-run the diff pane's effects on every
 * keystroke in the composer.
 */
const EMPTY_HUNKS: Hunk[] = [];

/**
 * What a panel shows when the thing it needs is missing.
 *
 * The rail's buttons stay enabled in that case on purpose: a button that does
 * nothing when pressed reads as broken, while a panel saying "pick a project
 * first" is an answer. It carries the same header and close button as a real
 * panel so the column does not visibly change shape.
 */
function PanelEmpty({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950"
    >
      <PanelHeader title={title} onClose={onClose} />
      <p className="p-4 text-ui text-neutral-500">{children}</p>
    </section>
  );
}

/**
 * The panel column's share of the panel+chat row, kept inside the bounds
 * prefs.ts advertises — a pane narrower than the minimum is one the divider
 * cannot be grabbed back from.
 */
const clampPanel = (percent: number): number =>
  Math.min(TERMINAL_MAX_PERCENT, Math.max(PANEL_MIN_PERCENT, percent));

export type { Panel } from "./prefs.js";

/** The chat panel the tab strip controls; `aria-controls` needs a real id. */
const CHAT_PANEL_ID = "chat-panel";

/** Same, for the split's second column. */
const SPLIT_PANEL_ID = "split-panel";

export default function App() {
  const [sessions, setSessions] = useState<PiSessionInfo[]>([]);
  /**
   * The project whose session list we have actually SEEN, successfully. It
   * gates dropping remembered tabs: absence from a list we never received is
   * not evidence of absence, and pruning on a failed or restarting-server
   * fetch would wipe the whole strip on a transient error.
   */
  const [listedProject, setListedProject] = useState("");
  /** Why the last session listing failed, shown in place of an empty list. */
  const [listError, setListError] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Stats, Packages or Settings, shown in a modal over everything. */
  const [page, setPage] = useState<PageId | null>(null);
  /**
   * Which side panel is showing, if any — one value, because they are
   * mutually exclusive the way VS Code's activity bar is: one column, one
   * divider, and clicking the lit icon closes it.
   *
   * A single value rather than a boolean each is what makes "two panels open
   * at once" unreachable instead of merely avoided by remembering to reset
   * the other three.
   *
   * Persisted, all four of them: a panel you had open before a reload (or
   * before switching browser tabs and coming back) should still be open, and
   * remembering only the terminal made every other one feel like it kept
   * closing itself. `showPanel` is the ONE writer, so no caller can move the
   * panel without the memory following.
   */
  const [panel, setPanel] = useState<Panel>(readPanel);

  /** Set the panel and remember it. Every path that changes `panel` goes here. */
  const showPanel = useCallback((next: Panel | ((current: Panel) => Panel)) => {
    setPanel((current) => {
      const resolved = typeof next === "function" ? next(current) : next;
      writePanel(resolved);
      return resolved;
    });
  }, []);
  /** True once the server's terminal list has been folded in; see below. */
  const [termsReady, setTermsReady] = useState(false);
  /** One width for the one panel column, whichever panel is in it. */
  const [panelWidth, setPanelWidth] = useState(readTerminalWidth);
  /** The session list's width in px; see prefs.ts. */
  const [listWidth, setListWidth] = useState(readListWidth);
  /**
   * The terminal pane's arrangement for the CURRENT project: its tabs,
   * splits and their shares. Per project, restored from storage and then
   * reconciled against the shells the server actually has — see the effect
   * below and termLayout.ts.
   */
  const [termLayout, setTermLayout] = useState<TermLayout>(EMPTY_LAYOUT);
  /** The row holding the panel, the chat and the divider between them. */
  const splitRow = useRef<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<ThemeId>(readTheme);
  const [editorTheme, setEditorTheme] = useState(readEditorTheme);
  const [userMode, setUserMode] = useState<UserMode>(readUserMode);
  const [askMode, setAskMode] = useState<AskMode>(readAskMode);
  const [notify, setNotify] = useState(readNotify);
  const [latestPrompt, setLatestPrompt] = useState(readLatestPrompt);
  const [sessionAttachments, setSessionAttachments] = useState(
    readSessionAttachments,
  );
  const [hideScrollbars, setHideScrollbars] = useState(readHideScrollbars);
  /** This pwi's project list: its directories plus the cwd it was launched against. */
  const [projects, setProjects] = useState<Projects>({
    projects: [],
    seed: "",
  });
  const [project, setProject] = useState<string>(
    () => readWindowProject() ?? "",
  );
  /** Tabs and the terminal layout are stored per project, keyed by its cwd. */
  const scope = project;
  const [sessionSort, setSessionSort] = useState<SessionSort>(readSessionSort);

  /*
   * index.html applies the stored theme before the first paint, so this is
   * not what dresses the app initially — it is the single writer afterwards,
   * and on mount it also normalises an attribute that storage set to
   * something no longer recognised.
   */
  useEffect(() => applyTheme(theme, editorTheme), [theme, editorTheme]);
  useEffect(() => applyHideScrollbars(hideScrollbars), [hideScrollbars]);
  // Settings owns later changes; this paints the stored fade once.
  useEffect(() => applyChatFade(readChatFade()), []);
  useEffect(() => applyScrollPast(readScrollPastOn(), readScrollPast()), []);
  useEffect(() => applyFooterLayout(readFooterLayout()), []);
  useEffect(() => applySessionLines(readSessionLines()), []);
  const changeUserMode = useCallback((mode: UserMode) => {
    setUserMode(mode);
    writeUserMode(mode);
  }, []);

  const changeAskMode = useCallback((mode: AskMode) => {
    setAskMode(mode);
    writeAskMode(mode);
  }, []);

  const changeLatestPrompt = useCallback((on: boolean) => {
    setLatestPrompt(on);
    writeLatestPrompt(on);
  }, []);
  const changeSessionSort = useCallback((next: SessionSort) => {
    setSessionSort(next);
    writeSessionSort(next);
  }, []);

  /**
   * Turning notifications on is what asks the browser for permission: the
   * click is the user gesture the prompt requires, and a refused prompt must
   * not leave a switch that claims to be on and silently does nothing.
   */
  const changeNotify = useCallback(async (on: boolean) => {
    if (!on) {
      setNotify(false);
      writeNotify(false);
      return;
    }
    if (typeof Notification === "undefined") return;
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    const granted = permission === "granted";
    setNotify(granted);
    writeNotify(granted);
  }, []);

  /**
   * The terminal pane: open/closed, and the divider that sizes it.
   *
   * Both preferences are written on change rather than in an effect, so a
   * pane closed and a window closed in the same second still agree.
   */
  const [dockOpen, setDockOpen] = useState(readDockOpen);
  const showTerminal = useCallback((open: boolean) => {
    setDockOpen(open);
    writeDockOpen(open);
  }, []);
  const closeTerminal = useCallback(() => showTerminal(false), [showTerminal]);
  const toggleTerminal = useCallback(() => {
    setDockOpen((open) => {
      writeDockOpen(!open);
      return !open;
    });
  }, []);

  /** The dock's share of the editor area's height, and that area for measuring drags. */
  const [dockHeight, setDockHeight] = useState(readDockHeight);
  const editorArea = useRef<HTMLDivElement | null>(null);
  const resizeDock = useCallback((percent: number, save: boolean) => {
    const clamped = Math.min(
      TERMINAL_MAX_PERCENT,
      Math.max(TERMINAL_MIN_PERCENT, percent),
    );
    setDockHeight(clamped);
    if (save) writeDockHeight(clamped);
  }, []);
  const startDockDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const area = editorArea.current?.getBoundingClientRect();
      if (!area || area.height === 0) return;
      let latest = dockHeight;
      startPointerDrag(
        event,
        (moved) => {
          latest = ((area.bottom - moved.clientY) / area.height) * 100;
          resizeDock(latest, false);
        },
        () => resizeDock(latest, true),
      );
    },
    [resizeDock, dockHeight],
  );
  const dockKeys = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 2;
      const next =
        event.key === "ArrowUp"
          ? dockHeight + step
          : event.key === "ArrowDown"
            ? dockHeight - step
            : event.key === "Home"
              ? TERMINAL_MIN_PERCENT
              : event.key === "End"
                ? TERMINAL_MAX_PERCENT
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      resizeDock(next, true);
    },
    [resizeDock, dockHeight],
  );

  /**
   * The rail's one action: show a panel, or close it if it is already the
   * one showing — the behaviour of every activity bar, and the reason the
   * state is a single value.
   */
  const selectPanel = useCallback(
    (next: Panel) => {
      showPanel((current) => (current === next ? null : next));
    },
    [showPanel],
  );

  /**
   * Restore this project's terminal layout, then intersect it with the
   * shells the server has.
   *
   * Both halves are load-bearing. A stored layout can name terminals that
   * are gone (the server was restarted, or another window closed one), which
   * would render panes wired to nothing; and the server can have terminals
   * the layout does not mention (another window opened one), which without
   * adoption would be unreachable — no pane referencing them, so nothing
   * able to close them either.
   *
   * Runs on project switch, not only on mount: the shells are per project.
   */
  useEffect(() => {
    setTermsReady(false);
    if (!project) {
      setTermLayout(EMPTY_LAYOUT);
      return;
    }
    setTermLayout(readTerminalLayout(scope));

    let live = true;
    void (async () => {
      const r = await api.terminals
        .$get({ query: { cwd: project } })
        .catch(() => null);
      if (!r?.ok || !live) return;
      const body = (await r.json()) as { terminals?: Array<{ id?: unknown }> };
      const ids = (body.terminals ?? [])
        .map((t) => t.id)
        .filter((id): id is string => typeof id === "string");
      setTermLayout((current) => reconcile(current, ids));
      // Gates the pane's "start the first shell" — spawning before the
      // server has been asked would mint a second shell next to the one
      // the stored layout was already pointing at.
      setTermsReady(true);
    })();
    return () => {
      live = false;
    };
  }, [project, scope]);

  /**
   * Every layout change is written through, so a reload, a crash and a
   * second window all see the same arrangement. Not debounced: a divider
   * drag is the only high-frequency source and it is already one write per
   * pointer event's worth of state, which localStorage handles at a cost
   * nobody can measure.
   */
  const changeTermLayout = useCallback(
    (next: TermLayout) => {
      setTermLayout(next);
      if (project) writeTerminalLayout(scope, next);
    },
    [project, scope],
  );

  /**
   * A new terminal tab whose shell starts in `dir`, then the terminal panel.
   * Keyed by the project like every other shell, so it survives a reload.
   */
  const startShell = async (dir: string): Promise<string> => {
    const r = await api.terminals.$post({ json: { cwd: project, dir } });
    const body = (await r.json().catch(() => ({}))) as {
      id?: string;
      error?: string;
    };
    if (!r.ok || !body.id)
      throw new Error(
        body.error ??
          t("could not start a shell ({status})", { status: r.status }),
      );
    return body.id;
  };
  const openTerminalAt = async (dir: string) => {
    changeTermLayout(addTab(termLayout, await startShell(dir)));
    showTerminal(true);
  };

  /** Clamped here, not at the call sites: every path in is a raw number. */
  const resizePanel = useCallback((percent: number) => {
    setPanelWidth(clampPanel(percent));
  }, []);

  /**
   * Drag the divider.
   *
   * The row is measured once, at pointerdown: it cannot change width while
   * the pointer is down, and measuring per move would be a forced layout on
   * every frame of the drag. Pointer capture is what keeps the move events
   * arriving once the cursor is over the terminal's canvas or outside the
   * window, and it ends the gesture for us if the pointer is cancelled.
   *
   * The width is persisted on release, not per move: a drag is one decision,
   * and writing localStorage a hundred times to record it is waste.
   */
  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const row = splitRow.current?.getBoundingClientRect();
      if (!row || row.width === 0) return;
      const divider = event.currentTarget;
      // The panel's left edge, not the row's: the activity bar sits between them.
      const left =
        divider.previousElementSibling?.getBoundingClientRect().left ??
        row.left;
      let latest = panelWidth;
      startPointerDrag(
        event,
        (moved) => {
          latest = ((moved.clientX - left) / row.width) * 100;
          resizePanel(latest);
        },
        () => writeTerminalWidth(clampPanel(latest)),
      );
    },
    [resizePanel, panelWidth],
  );

  /**
   * Keyboard resize, because a separator that only responds to a pointer is
   * one that a keyboard user cannot move at all. Right grows the panel — it
   * is on the left, so this is the opposite of what it was when the terminal
   * owned this divider. Home/End go to the advertised bounds.
   */
  const dividerKeys = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 2;
      const next =
        event.key === "ArrowRight"
          ? panelWidth + step
          : event.key === "ArrowLeft"
            ? panelWidth - step
            : event.key === "Home"
              ? PANEL_MIN_PERCENT
              : event.key === "End"
                ? TERMINAL_MAX_PERCENT
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      resizePanel(next);
      writeTerminalWidth(clampPanel(next));
    },
    [resizePanel, panelWidth],
  );

  /**
   * The session list's divider, the panel's done in px. The list sits on the
   * RIGHT, so it grows as the pointer moves left, and ArrowLeft grows it.
   */
  const startListDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const right = splitRow.current?.getBoundingClientRect().right;
      if (right === undefined) return;
      let latest: number | undefined;
      startPointerDrag(
        event,
        (moved) => {
          latest = clampListWidth(right - moved.clientX);
          setListWidth(latest);
        },
        () => {
          if (latest !== undefined) writeListWidth(latest);
        },
      );
    },
    [],
  );

  const listDividerKeys = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 64 : 16;
      const next =
        event.key === "ArrowLeft"
          ? listWidth + step
          : event.key === "ArrowRight"
            ? listWidth - step
            : event.key === "Home"
              ? LIST_MIN_PX
              : event.key === "End"
                ? LIST_MAX_PX
                : undefined;
      if (next === undefined) return;
      event.preventDefault();
      setListWidth(clampListWidth(next));
      writeListWidth(clampListWidth(next));
    },
    [listWidth],
  );

  /*
   * Read through refs inside the SSE handler: `attach` is memoized, and
   * making it depend on a preference would tear down and rebuild a live
   * EventSource every time one is toggled.
   */
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  /**
   * Announce a finished run — only when the page is not being watched.
   *
   * On screen and focused, the status line and the tab title already said
   * it, and a notification would be a second copy of news you are looking
   * at. `tag` is the session, so a session that finishes twice replaces its
   * own notification instead of stacking.
   */
  const announce = useCallback((file: string | undefined, body: string) => {
    if (!notifyRef.current) return;
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    const info = sessionsRef.current.find((s) => s.path === file);
    const title = info?.name || info?.firstMessage || "pwi";
    const n = new Notification(title, { body, tag: file ?? "pwi" });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }, []);

  const [tabs, setTabs] = useState<Tabs>({ project: "", files: [] });
  /** Pinned sessions: first in the list and first in each tab strip. */
  const [pinned, setPinned] = useState(readPinnedSessions);
  const pinnedRef = useRef(pinned);
  /**
   * Tab edits are computed from the CURRENT tabs and then committed, so they
   * read through a ref rather than a setState updater: closing a tab has to
   * know synchronously which neighbour to attach to, and a queued updater
   * cannot tell the caller that.
   */
  const tabsRef = useRef(tabs);
  /** Attaches each column's selected session; assigned below the session hooks. */
  const syncRef = useRef<(next: Tabs) => void>(() => {});
  const commitTabs = useCallback((raw: Tabs) => {
    // An emptied first column takes over the second's tabs; see `collapse`.
    // Here and not in each caller, because every tab mutation lands here.
    const collapsed = collapse(raw);
    // Pinned sessions lead each strip; applied here so no mutation can undo it.
    const pins = pinnedRef.current;
    const next = {
      ...collapsed,
      files: pinnedFirst(collapsed.files, pins),
      right: collapsed.right && {
        ...collapsed.right,
        files: pinnedFirst(collapsed.right.files, pins),
      },
    };
    tabsRef.current = next;
    setTabs(next);
    syncRef.current(next);
  }, []);

  /**
   * Sessions this page has opened successfully, which are therefore live
   * server-side whether or not they are on disk. `+ New` creates exactly such
   * a session: the JSONL is written lazily, so a brand-new session is absent
   * from the listing and must not be mistaken for a deleted one.
   */
  const opened = useRef<Set<string>>(new Set());

  /**
   * Sessions opened this page that the listing cannot see yet, keyed the same
   * way tabs are. `+ New` writes its JSONL lazily, so its row would otherwise
   * exist only while it is the attached session and disappear the moment
   * another one is selected. Entries are dropped by `shown` once the real
   * on-disk entry arrives or the tab is closed.
   */
  const [pending, setPending] = useState<PiSessionInfo[]>([]);

  /**
   * This pwi's project list.
   *
   * A failed read keeps `error` set rather than emptying the list: a
   * dropdown that is merely shorter looks exactly like "no projects here",
   * and the difference is the thing worth showing.
   */
  const loadProjects = useCallback(async (): Promise<void> => {
    const r = await api.projects.$get().catch(() => null);
    if (!r?.ok) {
      setProjects({
        projects: [],
        seed: "",
        error: r ? `HTTP ${r.status}` : t("not answering"),
      });
      return;
    }
    const body: unknown = await r.json().catch(() => null);
    const list =
      body &&
      typeof body === "object" &&
      "projects" in body &&
      Array.isArray(body.projects)
        ? body.projects.filter((p): p is string => typeof p === "string")
        : [];
    const seed =
      body &&
      typeof body === "object" &&
      "active" in body &&
      typeof body.active === "string"
        ? body.active
        : "";
    setProjects({ projects: list, seed });
  }, []);

  // Once: it seeds the list with this server's startup cwd, which is also
  // the fallback selection on a first visit.
  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  /*
   * Keep the selection pointing at a project that exists.
   *
   * A remembered project can vanish from the list (removed elsewhere); fall
   * back rather than polling a cwd that is no longer offered. Whatever
   * resolves here is then PINNED to this window, including the value it
   * inherited from the shared "last project anywhere" key: a window that
   * never touches the dropdown must still keep the project it opened on
   * when another window selects something else.
   */
  useEffect(() => {
    if (projects.error) return;
    if (project && projects.projects.includes(project)) return;
    if (!projects.seed) return;
    setProject(projects.seed);
    pinWindowProject(projects.seed);
  }, [project, projects]);

  // Switching projects clears the session list immediately, so the previous
  // project's sessions never linger under the new project's name.
  const selectProject = useCallback((next: string) => {
    setProject(next);
    pinWindowProject(next);
    writeStored(LAST_PROJECT_KEY, next);
    setSessions([]);
    setListedProject("");
    setListError(null);
  }, []);

  const addProject = useCallback(
    async (path: string) => {
      const r = await api.projects.$post({ json: { path } }).catch(() => null);
      const body = (await r?.json().catch(() => ({}))) as {
        error?: string;
        projects?: string[];
      };
      if (!r?.ok) {
        alert(body?.error ?? t("could not add project"));
        return;
      }
      const list = body.projects ?? [];
      setProjects((p) => ({ ...p, projects: list }));
      // Select what was just added — adding it and then hunting for it in the
      // dropdown is a pointless second step.
      const added = list.at(-1);
      if (added) selectProject(added);
    },
    [selectProject],
  );

  /**
   * Forget a project. The directory and its sessions are untouched — this is
   * the view, and pi's session store is keyed by cwd either way, so re-adding
   * the path brings every session back.
   */
  const removeProject = useCallback(
    async (path: string) => {
      const r = await api.projects
        .$delete({ json: { path } })
        .catch(() => null);
      if (!r?.ok) return;
      // Same shape as the POST response; typed once, then read.
      const body = (await r.json().catch(() => ({}))) as {
        projects?: string[];
      };
      const list = body.projects ?? [];
      setProjects((p) => ({ ...p, projects: list }));
      // Removing what you are looking at has to move the selection, or the
      // panel keeps polling a cwd that is no longer offered.
      if (!list.includes(path)) selectProject(list[0] ?? projects.seed);
    },
    [selectProject, projects.seed],
  );

  const refreshSessions = useCallback(async () => {
    if (!project) return;
    const r = await api.sessions
      .$get({ query: { cwd: project } })
      .catch(() => null);
    if (!r?.ok) {
      // Said out loud, not left as an empty list: no sessions and no answer
      // look the same in a list, and only one of them is the machine's fault.
      setListError(r ? `HTTP ${r.status}` : t("pwi is not answering"));
      return;
    }
    setListError(null);
    const body = await r.json();
    // Live but not on disk yet (an unprompted `+ New`): not deleted, so a
    // reload must not prune its tab.
    for (const f of body.live) opened.current.add(f);
    setSessions(body.sessions);
    setListedProject(scope);
  }, [project, scope]);

  /**
   * Rename a session. pi owns the name (PiSession.setName in
   * src/server/agent.ts sends `set_session_name`), which is why this is a
   * request and not a local edit: the name has to end up in the session
   * file, so the TUI and every other pwi window read the same one.
   *
   * Applied optimistically because the server may have to spawn a pi child
   * for a session nobody had open — a rename that takes two seconds to appear
   * reads as one that did not work. The refetch afterwards is what makes the
   * displayed name the stored one either way.
   */
  const renameSession = useCallback(
    async (session: PiSessionInfo, name: string) => {
      setSessions((list) =>
        list.map((s) => (s.path === session.path ? { ...s, name } : s)),
      );
      const r = await api.sessions.rename
        .$post({ json: { file: session.path, id: session.id, name } })
        .catch(() => null);
      if (!r?.ok) {
        const body = (await r?.json().catch(() => null)) as {
          error?: string;
        } | null;
        alert(body?.error ?? t("could not rename this session"));
      }
      await refreshSessions();
    },
    [refreshSessions],
  );

  /**
   * Let the server name the session: a one-shot `pi -p` child turns the
   * session's opening request into a title, which the server writes with
   * `set_session_name`.
   *
   * No optimistic update, because nothing here knows the answer — the server
   * waits for that child and answers with the name it produced. It can take
   * seconds, so the row says "Naming…" while this is in flight.
   */
  const autoNameSession = useCallback(
    async (session: PiSessionInfo) => {
      const r = await api.sessions.autoname
        .$post({ json: { file: session.path, id: session.id } })
        .catch(() => null);
      const body = (await r?.json().catch(() => null)) as {
        name?: string;
        error?: string;
      } | null;
      if (!r?.ok) {
        alert(body?.error ?? t("could not name this session"));
        return;
      }
      if (body?.name) {
        setSessions((list) =>
          list.map((s) =>
            s.path === session.path ? { ...s, name: body.name } : s,
          ),
        );
      }
      await refreshSessions();
    },
    [refreshSessions],
  );

  useEffect(() => {
    void refreshSessions();
    // Poll so a session working in the background (not attached, not this
    // tab's active one) still shows its live indicator without user action.
    const id = setInterval(() => void refreshSessions(), 5_000);
    return () => clearInterval(id);
  }, [refreshSessions]);

  /** Closes a tab in whichever column holds it; set once both closers exist. */
  const closeRef = useRef<(file: string) => void>(() => {});
  const env = {
    project,
    scope,
    tabsRef,
    commitTabs,
    closeRef,
    refreshSessions,
    announce,
    opened,
    setPending,
  };
  /** One session per column, so a split shows two conversations side by side. */
  const left = useSession({ side: "left", ...env });
  const right = useSession({ side: "right", ...env });
  /** The session app-wide chrome follows: the explorer's cwd, the git badge. */
  const snapshot = left.snapshot ?? right.snapshot;
  const busy = left.busy || right.busy;
  /** Bumped whenever the agent goes idle: a finished reply may have touched files. */
  const [replies, setReplies] = useState(0);
  useEffect(() => {
    if (!busy) setReplies((n) => n + 1);
  }, [busy]);
  /** Whose hunks a column's diff tabs decide on: its own session, else the other's. */
  const leftHunks = left.snapshot ? left : right;
  const rightHunks = right.snapshot ? right : left;

  /*
   * Point each column's session at the session tab it selects. Runs inside
   * every tab commit, so no mutation has to remember to attach or detach.
   * A column showing a file keeps its session attached underneath, unless
   * that session's tab left the column (closed, or dragged across).
   */
  syncRef.current = (next: Tabs) => {
    for (const [s, side] of [
      [left, "left"],
      [right, "right"],
    ] as const) {
      const group = groupOf(next, side);
      const target = s.targetRef.current;
      if (group.active && isSessionTab(group.active)) {
        if (group.active !== target) void s.attach(group.active);
      } else if (target && !group.files.includes(target)) s.detach();
    }
  };

  /**
   * Close a TAB — never the session.
   *
   * The run keeps going server-side (the first invariant: a detached session
   * that is still working is exactly the case that must keep running), the
   * JSONL stays on disk, and the session list still lists it. This is also
   * the silent-drop path for a remembered session that turned out to be gone,
   * because the bookkeeping is identical.
   *
   * Closing the active tab selects the tab that slid into its slot, so
   * closing the rightmost one lands on its left neighbour rather than
   * dumping the user on the empty pane.
   */
  const closeTab = useCallback(
    (file: string) => {
      const current = tabsRef.current;
      const index = current.files.indexOf(file);
      if (index < 0) return;
      const files = current.files.filter((f) => f !== file);
      if (current.active !== file) {
        commitTabs({ ...current, files });
        return;
      }
      const next: string | undefined = files[Math.min(index, files.length - 1)];
      commitTabs({ ...current, files, active: next });
    },
    [commitTabs],
  );

  /**
   * Close a tab in the second column, collapsing the split when it empties.
   *
   * Beside `closeTab` because it is the same operation on the other column,
   * and because the stale-session sweep needs both of them.
   */
  const closeRight = useCallback(
    (file: string) => {
      const current = tabsRef.current;
      if (!current.right) return;
      const pruned = withoutTab(current.right, file);
      if (!pruned) return;
      commitTabs(withGroup(current, "right", pruned));
    },
    [commitTabs],
  );

  /** Tabs the user closed, newest last, for Ctrl+T. Per page load, like a browser's. */
  const closedTabs = useRef<{ scope: string; side: Side; entry: string }[]>([]);
  const closeByUser = (side: Side) => (entry: string) => {
    if (sideOfTab(tabsRef.current, entry) === side)
      closedTabs.current.push({ scope, side, entry });
    if (side === "right") closeRight(entry);
    else closeTab(entry);
  };

  closeRef.current = (file) => {
    if (sideOfTab(tabsRef.current, file) === "right") closeRight(file);
    else closeTab(file);
  };

  /**
   * Adopt the tab set of the selected project.
   *
   * One effect covers both "restore on reload" and "switch project": tabs are
   * per-project state, so the only correct reaction to the project changing
   * is to swap the whole strip and reattach to its active session. A first
   * visit remembers nothing and lands on the empty pane rather than inventing
   * a session.
   *
   * The ref guard is load-bearing under StrictMode, which deliberately
   * double-invokes effects in development: without it the restore fires twice
   * and the second EventSource replaces the first mid-attach.
   */
  const adopted = useRef("");
  useEffect(() => {
    if (!project || adopted.current === scope) return;
    adopted.current = scope;
    // Detach first: the commit's sync then attaches each column's session.
    left.detach();
    right.detach();
    commitTabs(readTabs(scope));
  }, [project, scope, commitTabs, left.detach, right.detach]);

  useEffect(() => {
    // Never persist the placeholder state that precedes the first adoption;
    // it belongs to no project.
    if (tabs.project) {
      writeStored(
        `pwi:tabs:${tabs.project}`,
        JSON.stringify({
          files: tabs.files,
          active: tabs.active,
          right: tabs.right,
        }),
      );
    }
  }, [tabs]);

  /**
   * Drop remembered tabs whose session no longer exists, so a deleted session
   * does not come back as a permanently broken tab.
   *
   * Gated on positive evidence: a session list we actually received for THIS
   * project. Sessions this page opened are exempt because the JSONL is
   * written lazily — a `+ New` session that has not been prompted yet is
   * legitimately absent from the listing while being perfectly alive.
   */
  useEffect(() => {
    if (!listedProject || listedProject !== tabs.project) return;
    const gone = (file: string) =>
      // A file or diff tab is not a session and is not in the session
      // listing; only the sessions are checked for having gone away.
      isSessionTab(file) &&
      !opened.current.has(file) &&
      !sessions.some((s) => s.path === file);
    for (const file of tabs.files) if (gone(file)) closeTab(file);
    // The second column too: a session deleted elsewhere leaves a broken tab
    // whichever column it happens to be sitting in.
    for (const file of tabs.right?.files ?? [])
      if (gone(file)) closeRight(file);
  }, [sessions, listedProject, tabs, closeTab, closeRight]);

  /** The latest request to focus a column's chat composer. */
  const [sessionFocus, setSessionFocus] = useState({
    side: "left" as Side,
    entry: "",
    n: 0,
  });

  /**
   * Switch tabs: a chat session, or a file.
   *
   * Only a session attaches — a file tab is rendered from its own state and
   * has no server session behind it. Selecting one deliberately leaves the
   * attached session alone, so switching to a file and back does not tear
   * down a live EventSource or interrupt a streaming turn.
   */
  const selectTab = useCallback(
    (file: string) => {
      const current = tabsRef.current;
      if (isSessionTab(file))
        setSessionFocus((f) => ({ side: "left", entry: file, n: f.n + 1 }));
      if (current.active === file) return;
      commitTabs({
        ...current,
        files: current.files.includes(file)
          ? current.files
          : [...current.files, file],
        active: file,
      });
    },
    [commitTabs],
  );

  const togglePin = useCallback(
    (path: string) => {
      const current = pinnedRef.current;
      const next = current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path];
      pinnedRef.current = next;
      setPinned(next);
      writePinnedSessions(next);
      commitTabs(tabsRef.current);
    },
    [commitTabs],
  );

  /**
   * Move a tab within the strip.
   *
   * Order is the only thing that changes: no attach, no detach, no selection
   * change. Dragging the tab you are reading must not reload it, and it must
   * not steal the selection from the one you are streaming.
   */
  const reorderTabs = useCallback(
    (from: number, to: number) => {
      const current = tabsRef.current;
      const files = moveTab(current.files, from, to);
      if (files === current.files) return;
      commitTabs({ ...current, files });
    },
    [commitTabs],
  );

  /** Reorder within the second column. Same rules, other list. */
  const reorderRight = useCallback(
    (from: number, to: number) => {
      const current = tabsRef.current;
      if (!current.right) return;
      const files = moveTab(current.right.files, from, to);
      if (files === current.right.files) return;
      commitTabs({ ...current, right: { ...current.right, files } });
    },
    [commitTabs],
  );

  /**
   * Move a tab between the two editor columns, creating or closing the split.
   *
   * The ONE mutation for every version of this gesture — dragging onto a
   * body's half, onto the other column's strip, or back again — because they
   * are all the same thing: remove from one column, insert into the other,
   * and let an emptied second column collapse.
   *
   * Sessions move too: each column has its own session hook, and the
   * commit's sync moves the attachment along with the tab.
   */
  const moveToGroup = useCallback(
    (entry: string, to: Side, index?: number) => {
      const current = tabsRef.current;
      const from: Side = to === "left" ? "right" : "left";
      const target = groupOf(current, to);

      // Dropped on the left half of an unsplit column: the tab gets the left
      // column to itself and the rest move to a new right one.
      if (to === "left" && !current.right && index === undefined) {
        const rest = withoutTab(target, entry);
        if (rest && rest.files.length > 0) {
          commitTabs({
            ...current,
            files: [entry],
            active: entry,
            right: rest,
          });
          return;
        }
      }

      // Already there: focus it, and do not disturb the other column.
      const pruned = withoutTab(groupOf(current, from), entry);
      if (!pruned) {
        if (!target.files.includes(entry)) return;
        commitTabs(withGroup(current, to, withTab(target, entry)));
        return;
      }

      const grown = withTab(target, entry);
      // Landing at a specific slot rather than the end: the drop was onto a
      // tab, and the tab belongs where it was aimed.
      const files =
        index === undefined
          ? grown.files
          : moveTab(
              grown.files,
              grown.files.indexOf(entry),
              Math.min(index, grown.files.length - 1),
            );

      commitTabs(
        withGroup(withGroup(current, from, pruned), to, {
          files,
          active: entry,
        }),
      );
    },
    [commitTabs],
  );

  /**
   * Select within the second column.
   *
   * Attaches for the same reason `selectTab` does: a session tab can live in
   * either column now, and the one you pick is the one the chat shows.
   * Already-attached is skipped so switching away to a file and back does not
   * tear down a live EventSource mid-turn.
   */
  const selectRight = useCallback(
    (file: string) => {
      const current = tabsRef.current;
      if (current.right && isSessionTab(file))
        setSessionFocus((f) => ({ side: "right", entry: file, n: f.n + 1 }));
      if (!current.right || current.right.active === file) return;
      commitTabs({ ...current, right: withTab(current.right, file) });
    },
    [commitTabs],
  );

  const [fileReveal, setFileReveal] = useState<FileLocation>();

  /**
   * Open a file from the explorer or transcript, or focus its existing tab.
   *
   * A file already open in the SECOND column is focused there rather than
   * opened a second time on the left: two tabs for one file would be two
   * editors over one document, each with its own undo history and its own
   * idea of what is saved.
   */
  const openFile = useCallback(
    (path: string, line?: number, preferredSide: Side = "left") => {
      setFileReveal((previous) => fileLocation(previous, path, line));
      const entry = fileTab(path);
      // Transcript links prefer their own column, but never duplicate an existing editor.
      // Explorer clicks retain their default of opening new file tabs on the left.
      if (
        (sideOfTab(tabsRef.current, entry) ?? preferredSide) === "right" &&
        tabsRef.current.right
      ) {
        selectRight(entry);
        return;
      }
      selectTab(entry);
    },
    [selectTab, selectRight],
  );

  /**
   * The column a panel's click should open a tab in: the last one touched.
   *
   * Without this, every diff opened from the sidebar lands on the left and
   * covers the chat — which is the one thing you are looking at a diff
   * BESIDE. A ref for synchronous reads; the state copy drives the split's
   * focus cue, and only re-renders when the column actually changes.
   */
  const lastSide = useRef<Side>("left");
  const [focusedSide, setFocusedSide] = useState<Side>("left");
  const markSide = useCallback((side: Side) => {
    lastSide.current = side;
    setFocusedSide(side);
  }, []);

  /**
   * Open one file's diff in a tab, in the column last used.
   *
   * Same identity rule as `openFile`: the entry encodes the commit AND the
   * path, so the working tree's diff and the same file three commits ago are
   * two tabs, while clicking the same row twice focuses the one that is
   * already open.
   */
  const openInLastSide = useCallback(
    (entry: string) => {
      const open = sideOfTab(tabsRef.current, entry);
      // Already open somewhere: focus it there, wherever that is. A second
      // copy in the other column would be two merge views over one file.
      const side = open ?? lastSide.current;
      if (side === "right" && tabsRef.current.right) selectRight(entry);
      else if (side === "right") moveToGroup(entry, "right");
      else selectTab(entry);
    },
    [selectTab, selectRight, moveToGroup],
  );
  const openDiff = useCallback(
    (ref: string, path: string) => openInLastSide(diffTab(ref, path)),
    [openInLastSide],
  );

  /**
   * The dock lists every shell; an editor tab is just another view of one.
   * Closing the tab leaves the shell running in the dock, and a shell that
   * leaves the dock (killed there) takes its editor tabs with it.
   */
  const termToEditor = useCallback(
    (id: string) => openInLastSide(termTab(id)),
    [openInLastSide],
  );
  /** A new shell as an editor tab in one column, listed in the dock too. */
  const newTerminalTab = async (side: Side) => {
    try {
      const id = await startShell(project);
      dockShell(id);
      const entry = termTab(id);
      if (side === "right") selectRight(entry);
      else selectTab(entry);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  /** List a shell in the dock. An updater, so it composes with other layout changes. */
  const dockShell = useCallback(
    (id: string) => {
      setTermLayout((current) => {
        if (allTerminals(current).includes(id)) return current;
        const next = addTab(current, id);
        if (project) writeTerminalLayout(scope, next);
        return next;
      });
    },
    [project, scope],
  );
  // Only once the dock is reconciled with the server: before that an empty
  // layout means "not loaded", not "no shells".
  useEffect(() => {
    if (!termsReady) return;
    const live = new Set(allTerminals(termLayout));
    const t = tabsRef.current;
    for (const e of t.files)
      if (isTermTab(e) && !live.has(termId(e))) closeTab(e);
    for (const e of t.right?.files ?? [])
      if (isTermTab(e) && !live.has(termId(e))) closeRight(e);
  }, [termsReady, termLayout, closeTab, closeRight]);

  /**
   * Open a file in the second column, splitting if there is none.
   *
   * One tab per file still holds: a file already open on the left MOVES
   * right rather than getting a second editor over the same document.
   */
  const openToSide = useCallback(
    (path: string) => {
      const entry = fileTab(path);
      const current = tabsRef.current;
      const side = sideOfTab(current, entry);
      markSide("right");
      if (side === "right") selectRight(entry);
      else if (side === "left") moveToGroup(entry, "right");
      else
        commitTabs(
          withGroup(
            current,
            "right",
            withTab(groupOf(current, "right"), entry),
          ),
        );
    },
    [commitTabs, selectRight, moveToGroup],
  );

  /**
   * The last "Add to Chat": which column's composer it went into, and a
   * counter that tells that Chat to re-read its draft and take focus.
   */
  const [inserted, setInserted] = useState<{ side: Side; n: number }>({
    side: "left",
    n: 0,
  });

  /**
   * Which column's session "Add to Chat" writes to: a session SHOWING in the
   * last-used column, then one showing in the other, then any attached one.
   * Null when no session is open, which disables the action.
   */
  const chatTarget = (): {
    side: Side;
    id: string;
    entry: string;
    showing: boolean;
  } | null => {
    const order: Side[] =
      lastSide.current === "right" ? ["right", "left"] : ["left", "right"];
    const hits = order.map((side) => {
      const snap = (side === "left" ? left : right).snapshot;
      if (!snap) return null;
      const group = groupOf(tabsRef.current, side);
      const entry = group.files.find(
        (f) => isSessionTab(f) && (f === snap.file || f === snap.id),
      );
      return entry
        ? { side, id: snap.id, entry, showing: group.active === entry }
        : null;
    });
    return hits.find((h) => h?.showing) ?? hits.find((h) => h !== null) ?? null;
  };

  /**
   * Append text to a session's composer, through its persisted draft so the
   * Chat's one restore path picks it up, and bring that session forward.
   */
  const addToChat = (text: string) => {
    const target = chatTarget();
    if (!target) return;
    const prev = splitPastedText(readDraft(target.id).text);
    writeDraftText(
      target.id,
      joinPastedText(
        `${prev.text}${prev.text && !/\s$/.test(prev.text) ? " " : ""}${text} `,
        prev.attachments,
      ),
    );
    if (!target.showing) {
      if (target.side === "right") selectRight(target.entry);
      else selectTab(target.entry);
    }
    markSide(target.side);
    setInserted((i) => ({ side: target.side, n: i.n + 1 }));
  };

  /**
   * Which open files have unsaved edits, so the strip can dot them.
   *
   * Held here rather than in FileEditor because the strip is rendered from
   * here and cannot see into a tab's body — without it a modified file would
   * look exactly like a saved one from the outside.
   */
  const [dirtyFiles, setDirtyFiles] = useState<Record<string, boolean>>({});
  const onFileDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyFiles((current) =>
      // Same value: return the SAME object. A fresh one on every keystroke
      // would re-render the whole strip while typing.
      (current[path] ?? false) === dirty
        ? current
        : { ...current, [path]: dirty },
    );
  }, []);

  /** A file a tab asked the Explorer to show; cleared once it has been shown. */
  const [reveal, setReveal] = useState<string | null>(null);
  const revealFile = useCallback(
    (path: string) => {
      setReveal(path);
      showPanel("editor");
    },
    [showPanel],
  );

  /** The explorer renamed `from` to `to`, or deleted it (null): open file tabs follow. */
  const onPathChange = useCallback(
    (from: string, to: string | null) =>
      commitTabs(afterPathChange(tabsRef.current, from, to)),
    [commitTabs],
  );
  /** Unsaved edits at or under `path`, which a rename or delete would strand. */
  const hasUnsaved = (path: string) =>
    Object.entries(dirtyFiles).some(
      ([p, dirty]) => dirty && (p === path || p.startsWith(`${path}/`)),
    );

  /*
   * Notice when the server we are talking to is not the one that served this
   * page.
   *
   * The session layer already survives a restart — the EventSource reattaches
   * through the file — so this is about the BUNDLE: the JS and CSS in this tab
   * are from the old build, and a page left open across a deploy runs code
   * that no longer matches the server. The failures that produces are quiet
   * and confusing, so say it plainly instead.
   *
   * A banner and not an automatic reload: a reload mid-run would throw away
   * the transcript on screen for a reason the user never asked about. Drafts
   * are written on every keystroke, so taking it is cheap whenever they like.
   */
  const [restarted, setRestarted] = useState(false);

  /**
   * Uncommitted files, for the rail badge. From git, like the panel: the
   * session's hunks stay "pending" after a commit, so counting them left the
   * badge lit on a clean tree until a new session.
   */
  const [uncommitted, setUncommitted] = useState(0);
  const gitCwd = snapshot?.cwd || project;
  useEffect(() => {
    if (!gitCwd) return setUncommitted(0);
    let live = true;
    const read = () =>
      unwrap(api.git.changes.$get({ query: { cwd: gitCwd } }))
        .then((b) => live && setUncommitted(b.files.length))
        .catch(() => {});
    void read();
    // A commit from the chat's button: the panel may be closed, so re-read here.
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === gitCwd) void read();
    };
    window.addEventListener(GIT_CHANGED, on);
    return () => {
      live = false;
      window.removeEventListener(GIT_CHANGED, on);
    };
  }, [gitCwd, snapshot?.hunks]);
  useEffect(() => {
    let boot: string | undefined;
    let live = true;
    const check = async () => {
      const r = await api.health.$get().catch(() => null);
      if (!live || !r?.ok) return; // down is not restarted; say nothing yet
      const body: unknown = await r.json().catch(() => null);
      const seen =
        body &&
        typeof body === "object" &&
        "boot" in body &&
        typeof body.boot === "string"
          ? body.boot
          : undefined;
      // An older server has no `boot` at all, and cannot be compared. Saying
      // nothing is right: it is exactly the case this banner is wrong about.
      if (!seen) return;
      if (boot === undefined) boot = seen;
      else if (seen !== boot) setRestarted(true);
    };
    void check();
    // Slow on purpose. This is a background fact, not a thing to poll hard:
    // the cost of noticing a minute late is a stale tab for a minute.
    const t = setInterval(() => void check(), 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // A session created by `+ New` has no JSONL until its first prompt, so
  // /api/sessions (which lists disk) cannot see it. Show it anyway — in the
  // list and as a tab title — for as long as it has a tab and no on-disk
  // entry. Tab membership is the lifetime: closing the tab drops the row, and
  // tabs are per-project, so another project's unsaved session never leaks in.
  const shown = useMemo(() => {
    // Either column: a session dragged into the split is still open, and
    // checking only the left one would drop its title the moment it moved.
    const open = new Set([...tabs.files, ...(tabs.right?.files ?? [])]);
    const extra = pending.filter(
      (p) => open.has(p.path) && !sessions.some((s) => s.path === p.path),
    );
    const all = extra.length ? [...extra, ...sessions] : sessions;
    // An attached session's live stream beats the 5s poll, so the tab's π
    // lights the moment a prompt is sent and dims the moment it ends.
    // The same for a question: it arrives as an event, long before a poll.
    const live = new Map<
      string,
      { isStreaming: boolean; needsInput: boolean } & ReturnType<
        typeof sessionPrompts
      >
    >();
    for (const c of [left, right])
      if (c.snapshot)
        live.set(c.snapshot.file ?? c.snapshot.id, {
          isStreaming: c.busy,
          needsInput: c.snapshot.ask !== null,
          ...sessionPrompts(c.snapshot.messages),
        });
    if (!live.size) return all;
    return all.map((s) => {
      const l = live.get(s.path);
      return l ? { ...s, ...l } : s;
    });
  }, [
    sessions,
    pending,
    tabs.files,
    tabs.right,
    left.snapshot?.file,
    left.snapshot?.id,
    left.snapshot?.ask,
    left.snapshot?.messages,
    left.busy,
    right.snapshot?.file,
    right.snapshot?.id,
    right.snapshot?.ask,
    right.snapshot?.messages,
    right.busy,
  ]);

  /*
   * What this browser has seen of each session, and whether the user can see
   * the window at all: a reply that lands while they are in another app is
   * still one they have not read. Another pwi window's reads count too.
   */
  const [seen, setSeen] = useState(readSeenSessions);
  const [looking, setLooking] = useState(
    () => document.visibilityState === "visible" && document.hasFocus(),
  );
  useEffect(() => {
    const update = () =>
      setLooking(document.visibilityState === "visible" && document.hasFocus());
    const reload = () => setSeen(readSeenSessions());
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("storage", reload);
    };
  }, []);

  const onScreen = useMemo(
    () => (looking ? [tabs.active, tabs.right?.active] : []),
    [looking, tabs.active, tabs.right?.active],
  );

  // A session on screen is seen up to its latest activity. Re-read first, so
  // another window's marks are merged rather than overwritten.
  useEffect(() => {
    const stale = shown.filter(
      (s) => onScreen.includes(s.path) && seen.seen[s.path] !== s.lastActive,
    );
    if (!stale.length) return;
    const fresh = readSeenSessions();
    for (const s of stale) fresh.seen[s.path] = s.lastActive;
    writeSeenSessions(fresh);
    setSeen(fresh);
  }, [shown, onScreen, seen]);

  // On-screen sessions never count as waiting, even for the render before
  // the effect above records them.
  const attention = useMemo(
    () =>
      new Map<string, Attention>(
        shown.map((s) => {
          const a = attentionOf(s, seen);
          return [
            s.path,
            a === "ready" && onScreen.includes(s.path) ? null : a,
          ];
        }),
      ),
    [shown, seen, onScreen],
  );

  // A session not attached in a column has no event stream here, so its
  // finished run or question is caught from the list poll instead.
  const polled = useRef(new Map<string, PiSessionInfo>());
  useEffect(() => {
    const attached = [tabs.active, tabs.right?.active];
    for (const s of shown) {
      const was = polled.current.get(s.path);
      polled.current.set(s.path, s);
      if (!was || attached.includes(s.path)) continue;
      if (s.needsInput && !was.needsInput)
        announce(s.path, t("Needs your answer"));
      else if (was.isStreaming && !s.isStreaming && !s.needsInput)
        announce(s.path, t("Finished"));
    }
  }, [shown, tabs.active, tabs.right?.active, announce]);

  // Title and icon carry it for a tab you are not looking at: the title is
  // readable, the icon survives a strip too narrow for any title.
  const states = [...attention.values()];
  const working = states.includes("working");
  const badge = states.includes("needs")
    ? "needs"
    : states.includes("ready")
      ? "ready"
      : null;
  const title = attentionTitle(states);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => setFavicon(working, badge), [working, badge]);

  /** Focus a session where it is open, or open it on the left, and focus its composer. */
  const focusSession = useCallback(
    (path: string) => {
      // Adding it to the left while it is open on the right would put one
      // session in both columns.
      const side: Side =
        sideOfTab(tabsRef.current, path) === "right" ? "right" : "left";
      if (side === "right") selectRight(path);
      else selectTab(path);
      markSide(side);
      setSessionFocus((f) => ({ side, entry: path, n: f.n + 1 }));
    },
    [selectTab, selectRight, markSide],
  );

  /** Open a new session in `side` and focus its column and composer. */
  const newSession = async (side: Side) => {
    const key = await (side === "right" ? right : left).attach();
    if (!key) return;
    markSide(side);
    setSessionFocus((f) => ({ side, entry: key, n: f.n + 1 }));
  };

  /**
   * Jump to the next session waiting on you: questions first, then the
   * reply that has waited longest.
   */
  const jumpToWaiting = useCallback(() => {
    const t = tabsRef.current;
    const current =
      lastSide.current === "right" && t.right ? t.right.active : t.active;
    const next = nextWaiting(shown, attention, current);
    if (next) focusSession(next);
    return !!next;
  }, [shown, attention, focusSession]);

  /** Everything the Ctrl+P palette can run. */
  const lastUsedSide = (): Side =>
    lastSide.current === "right" && tabsRef.current.right ? "right" : "left";

  /** Reopen the newest closed tab of this project that is not open again already. */
  const reopenClosedTab = () => {
    const stack = closedTabs.current;
    for (let i = stack.length - 1; i >= 0; i--) {
      const { scope: s, side, entry } = stack[i];
      if (s !== scope) continue;
      stack.splice(i, 1);
      if (sideOfTab(tabsRef.current, entry)) continue;
      if (side === "right" && tabsRef.current.right) selectRight(entry);
      else selectTab(entry);
      return;
    }
  };

  /**
   * Every shortcut in Settings > Shortcuts, dispatched from one capture
   * listener on window, so neither the browser nor a focused terminal or
   * editor sees a key that pwi handles. A handler that finds nothing to do
   * (Go to Tab 7 with three tabs) returns false and the key goes on.
   */
  const shortcutActions = useRef<
    Record<ShortcutId, (digit: number) => boolean>
  >(null!);
  shortcutActions.current = {
    "tab.reopen": () => (reopenClosedTab(), true),
    "session.new": () => (void newSession(lastUsedSide()), true),
    "session.search": () => (setSearchOpen(true), true),
    palette: () => (setSearchOpen(false), setPaletteOpen(true), true),
    "view.terminal": () => (toggleTerminal(), true),
    "session.nextWaiting": () => jumpToWaiting(),
    "tab.select": (digit) => {
      const file = tabsRef.current.files[digit - 1];
      if (file) selectTab(file);
      return !!file;
    },
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (recorder.active) return;
      const hit = matchShortcut(e, readBindings());
      if (!hit || !shortcutActions.current[hit.id](hit.digit)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const paletteCommands: PaletteCommand[] = [
    {
      id: "session.new",
      label: t("New AI Session"),
      keys: shortcutKeys("session.new"),
      run: () => void (lastUsedSide() === "right" ? right : left).attach(),
    },
    {
      id: "tab.reopen",
      label: t("Reopen Closed Tab"),
      keys: shortcutKeys("tab.reopen"),
      run: reopenClosedTab,
    },
    ...(project
      ? [
          {
            id: "terminal.newTab",
            label: t("New Terminal Tab"),
            run: () => void newTerminalTab(lastUsedSide()),
          },
        ]
      : []),
    {
      id: "session.search",
      label: t("Search Sessions"),
      keys: shortcutKeys("session.search"),
      run: () => setSearchOpen(true),
    },
    {
      id: "session.nextWaiting",
      label: t("Go to Next Waiting Session"),
      keys: shortcutKeys("session.nextWaiting"),
      run: jumpToWaiting,
    },
    {
      id: "view.explorer",
      label: panel === "editor" ? t("Hide Explorer") : t("Show Explorer"),
      run: () => selectPanel("editor"),
    },
    {
      id: "view.sourceControl",
      label:
        panel === "review"
          ? t("Hide Source Control")
          : t("Show Source Control"),
      run: () => selectPanel("review"),
    },
    {
      id: "view.terminal",
      label: dockOpen ? t("Hide Terminal") : t("Show Terminal"),
      keys: shortcutKeys("view.terminal"),
      run: toggleTerminal,
    },
    { id: "page.fleet", label: t("Open Fleet"), run: () => setPage("fleet") },
    { id: "page.stats", label: t("Open Stats"), run: () => setPage("stats") },
    {
      id: "page.packages",
      label: t("Open Packages"),
      run: () => setPage("packages"),
    },
    {
      id: "page.settings",
      label: t("Open Settings"),
      run: () => setPage("settings"),
    },
    ...THEMES.filter((th) => th.id !== theme).map((th) => ({
      id: `theme.${th.id}`,
      label: t("Theme: {name}", { name: th.label }),
      run: () => setTheme(th.id),
    })),
    {
      id: "window.reload",
      label: t("Reload Window"),
      run: () => location.reload(),
    },
  ];

  /** A page's content inside the page dialog. */
  const renderPage = (page: PageId, active: boolean) => {
    const onClose = () => setPage(null);
    if (page === "stats")
      return <Stats open={active} revision={replies} onClose={onClose} />;
    if (page === "fleet") return <Fleet open={active} onClose={onClose} />;
    if (page === "themes")
      return (
        <Themes
          theme={theme}
          onTheme={setTheme}
          editorTheme={editorTheme}
          onEditorTheme={setEditorTheme}
          onClose={onClose}
        />
      );
    if (page === "packages")
      return (
        <Packages
          open={active}
          onChanged={() => {
            void left.reloadSnapshot();
            void right.reloadSnapshot();
          }}
          cwd={project}
          onClose={onClose}
        />
      );
    return (
      <Settings
        cwd={project}
        open={active}
        theme={theme}
        editorTheme={editorTheme}
        onEditorTheme={setEditorTheme}
        onBrowseThemes={() => setPage("themes")}
        userMode={userMode}
        onUserMode={changeUserMode}
        askMode={askMode}
        onAskMode={changeAskMode}
        notify={notify}
        onNotify={(on) => void changeNotify(on)}
        latestPrompt={latestPrompt}
        onLatestPrompt={changeLatestPrompt}
        sessionAttachments={sessionAttachments}
        onSessionAttachments={(show) => {
          setSessionAttachments(show);
          writeSessionAttachments(show);
        }}
        sessionSort={sessionSort}
        onSessionSort={changeSessionSort}
        hideScrollbars={hideScrollbars}
        onHideScrollbars={setHideScrollbars}
        onClose={onClose}
      />
    );
  };

  /** One column's chat, wired to that column's session. */
  const chatFor = (s: ReturnType<typeof useSession>, side: Side) => (
    <FileNavigationContext.Provider
      value={(path, line) => openFile(path, line, side)}
    >
      <Chat
        snapshot={s.snapshot}
        draftRev={inserted.side === side ? inserted.n : 0}
        focus={sessionFocus.side === side ? sessionFocus : undefined}
        partial={s.partial}
        busy={s.busy}
        opening={s.opening}
        userMode={userMode}
        askMode={askMode}
        onAskMode={changeAskMode}
        command={s.command}
        modelError={s.modelError}
        onSend={s.send}
        onAnswerAsk={s.answerAsk}
        onAbort={s.abort}
        onModelChange={s.changeModel}
        onThinkingChange={s.changeThinking}
        onFastChange={s.changeFast}
        onCommandMenu={s.refreshCommands}
        onCompact={s.compact}
        compacting={s.compacting}
        onFork={s.fork}
        onEdit={s.edit}
        onRestart={s.restart}
      />
    </FileNavigationContext.Provider>
  );

  return (
    <div ref={splitRow} className="flex h-full bg-neutral-950 text-neutral-100">
      {/*
			  Fixed, and above everything: the point is that it is visible whichever
			  pane you are looking at. Dismissible because a tab you are only reading
			  does not have to act on it.
			*/}
      {restarted && (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-amber-800 bg-amber-950/95 px-3 py-1.5 text-ui text-amber-200">
          <span>
            {t("pwi restarted — this page is running the previous build.")}
          </span>
          <Button variant="warning" size="sm" onClick={() => location.reload()}>
            {t("Reload")}
          </Button>
          <IconButton
            size="sm"
            onClick={() => setRestarted(false)}
            label={t("Dismiss")}
          >
            <X size={13} className="text-amber-400" />
          </IconButton>
        </div>
      )}
      {/* The rail owns every panel toggle, and never scrolls. */}
      <ActivityBar
        panel={panel}
        onSelect={selectPanel}
        uncommitted={uncommitted}
        dockOpen={dockOpen}
        onToggleDock={toggleTerminal}
        onPage={setPage}
        version={__APP_VERSION__}
      />

      {/*
       * THE panel column — one column, whichever panel the rail selected,
       * sitting immediately right of the button that opened it.
       *
       * Each panel states its own requirement rather than the rail hiding
       * the button: both need a project. A button that silently does nothing
       * is worse than one that opens a panel explaining what is missing.
       */}
      {panel !== null && (
        <>
          <div
            className="flex min-h-0 min-w-0 flex-col narrow:flex-1 wide:[flex:0_0_var(--panel-w)]"
            style={{ "--panel-w": `${panelWidth}%` } as React.CSSProperties}
          >
            {panel === "editor" &&
              (project || snapshot ? (
                <Explorer
                  key={snapshot?.cwd || project || ""}
                  cwd={snapshot?.cwd || project || ""}
                  openPath={
                    tabs.active && isFileTab(tabs.active)
                      ? tabPath(tabs.active)
                      : null
                  }
                  onOpen={openFile}
                  onOpenSide={openToSide}
                  onPathChange={onPathChange}
                  reveal={reveal}
                  onRevealed={() => setReveal(null)}
                  hasUnsaved={hasUnsaved}
                  onOpenDiff={openDiff}
                  onOpenTerminal={project ? openTerminalAt : undefined}
                  onAddToChat={
                    left.snapshot || right.snapshot ? addToChat : undefined
                  }
                  onClose={() => showPanel(null)}
                  revision={replies}
                >
                  <ProjectPicker
                    projects={projects}
                    project={project}
                    onProject={selectProject}
                    onAddProject={(p) => void addProject(p)}
                    onRemoveProject={(p) => void removeProject(p)}
                  />
                </Explorer>
              ) : (
                <PanelEmpty
                  title={t("Explorer")}
                  onClose={() => showPanel(null)}
                >
                  {t("Pick a project first — the file tree is rooted at it.")}
                </PanelEmpty>
              ))}

            {/*
             * Needs a PROJECT and not a session, unlike the panel it replaced:
             * the working tree and the log belong to the repository, not to a
             * conversation, and refusing to show them until a session is open
             * was the old Changes panel asking for something it did not use.
             * A session only adds the hunk decisions inside a diff tab.
             */}
            {panel === "review" &&
              (snapshot?.cwd || project ? (
                <SourceControl
                  cwd={snapshot?.cwd || project}
                  // The agent's hunks are the cheapest "the tree moved"
                  // signal this app has; the panel re-reads on it.
                  revision={snapshot?.hunks}
                  onClose={() => showPanel(null)}
                  onOpenDiff={openDiff}
                  onChanges={setUncommitted}
                />
              ) : (
                <PanelEmpty
                  title={t("Source Control")}
                  onClose={() => showPanel(null)}
                >
                  {t(
                    "Pick a project first — a working tree belongs to a repository.",
                  )}
                </PanelEmpty>
              ))}
          </div>
          {/* Hidden on narrow, where the panel IS the view and there is
					    nothing beside it to resize. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("Resize panel")}
            aria-valuenow={Math.round(panelWidth)}
            aria-valuemin={PANEL_MIN_PERCENT}
            aria-valuemax={TERMINAL_MAX_PERCENT}
            tabIndex={0}
            onPointerDown={startDrag}
            {...hoverIntent}
            onKeyDown={dividerKeys}
            // The `after` box is the real hit area: a 1px line is a target
            // you miss, and there is nothing else to aim at. 13px, leaning
            // right so it stays off the panel's scrollbar; z-10 so the
            // editor beside it cannot paint over half of it.
            className="relative z-10 w-0 shrink-0 data-hover:cursor-col-resize border-l border-neutral-800 transition-colors delay-1000 duration-500 ease-out after:absolute after:inset-y-0 after:-left-0.75 after:-right-2.5 after:content-[''] data-hover:border-amber-600 data-hover:delay-0 data-hover:duration-100 focus-visible:border-amber-500 focus-visible:outline-none motion-reduce:transition-none narrow:hidden"
          />
        </>
      )}

      {/* On a phone the panel IS the view: two columns there is three words
			    per line each. Same rule the session list follows. */}
      <div
        ref={editorArea}
        className={`flex min-h-0 min-w-0 flex-1 flex-col ${panel !== null ? "narrow:hidden" : ""}`}
      >
        <div className="flex min-h-0 min-w-0 flex-1">
          {/*
           * The two editor columns, as SIBLINGS.
           *
           * Each owns its own tab strip, so a split looks like two editors side
           * by side rather than one nested in the other's body — which is both
           * what VS Code does and the only arrangement where the second
           * column's tabs sit at the same height as the first's.
           */}
          <EditorColumn
            side="left"
            onReveal={revealFile}
            onTogglePin={togglePin}
            onRename={(s, name) => void renameSession(s, name)}
            onAutoName={autoNameSession}
            group={groupOf(tabs, "left")}
            panelId={CHAT_PANEL_ID}
            sessions={shown}
            attention={attention}
            latestPrompt={latestPrompt}
            pinned={pinned}
            dirtyFiles={dirtyFiles}
            fileReveal={fileReveal}
            onSelect={selectTab}
            onClose={closeByUser("left")}
            onNewSession={() => void newSession("left")}
            onNewTerminal={
              project ? () => void newTerminalTab("left") : undefined
            }
            onReorder={reorderTabs}
            onMove={moveToGroup}
            onFocus={() => {
              markSide("left");
            }}
            listOpen={listOpen}
            onToggleList={() => setListOpen((o) => !o)}
            cwd={snapshot?.cwd || project || ""}
            onDirty={onFileDirty}
            sessionId={leftHunks.snapshot?.id}
            hunks={leftHunks.snapshot?.hunks ?? EMPTY_HUNKS}
            onHunksChanged={() => void leftHunks.reloadSnapshot()}
            chat={chatFor(left, "left")}
            messages={left.snapshot?.messages}
            focused={!tabs.right || focusedSide === "left"}
          />

          {tabs.right && (
            <EditorColumn
              side="right"
              onReveal={revealFile}
              onTogglePin={togglePin}
              onRename={(s, name) => void renameSession(s, name)}
              onAutoName={autoNameSession}
              group={tabs.right}
              panelId={SPLIT_PANEL_ID}
              sessions={shown}
              attention={attention}
              latestPrompt={latestPrompt}
              pinned={pinned}
              dirtyFiles={dirtyFiles}
              fileReveal={fileReveal}
              onSelect={selectRight}
              onClose={closeByUser("right")}
              onNewSession={() => void newSession("right")}
              onNewTerminal={
                project ? () => void newTerminalTab("right") : undefined
              }
              onReorder={reorderRight}
              onMove={moveToGroup}
              onFocus={() => {
                markSide("right");
              }}
              cwd={snapshot?.cwd || project || ""}
              onDirty={onFileDirty}
              sessionId={rightHunks.snapshot?.id}
              hunks={rightHunks.snapshot?.hunks ?? EMPTY_HUNKS}
              onHunksChanged={() => void rightHunks.reloadSnapshot()}
              // Only a column holding a session gets a chat; otherwise it says
              // "drag a tab here" instead of showing an empty conversation.
              chat={
                tabs.right.files.some(isSessionTab)
                  ? chatFor(right, "right")
                  : null
              }
              messages={right.snapshot?.messages}
              focused={focusedSide === "right"}
            />
          )}
        </div>

        {/* The terminal dock: under BOTH columns, because the shells belong to
				    the project, not to a column. */}
        {dockOpen && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("Resize terminal")}
              aria-valuenow={Math.round(dockHeight)}
              aria-valuemin={TERMINAL_MIN_PERCENT}
              aria-valuemax={TERMINAL_MAX_PERCENT}
              tabIndex={0}
              onPointerDown={startDockDrag}
              {...hoverIntent}
              onKeyDown={dockKeys}
              className="relative z-10 h-0 shrink-0 data-hover:cursor-row-resize border-t border-neutral-800 transition-colors delay-1000 duration-500 ease-out after:absolute after:inset-x-0 after:-top-1.25 after:-bottom-1 after:content-[''] data-hover:border-amber-600 data-hover:delay-0 data-hover:duration-100 focus-visible:border-amber-500 focus-visible:outline-none motion-reduce:transition-none"
            />
            <div
              className="flex min-h-0 min-w-0 flex-col [flex:0_0_var(--dock-h)]"
              style={{ "--dock-h": `${dockHeight}%` } as React.CSSProperties}
            >
              {project ? (
                <TerminalPane
                  cwd={project}
                  ready={termsReady}
                  layout={termLayout}
                  onLayout={changeTermLayout}
                  onClose={closeTerminal}
                  onToEditor={termToEditor}
                />
              ) : (
                <PanelEmpty title={t("Terminal")} onClose={closeTerminal}>
                  {t("Pick a project first: a shell has to start somewhere.")}
                </PanelEmpty>
              )}
            </div>
          </>
        )}
      </div>

      {/* The session list moved to the RIGHT edge, opposite the rail: the two
			    pieces of persistent chrome now bracket the window instead of
			    stacking on one side. It keeps its narrow-viewport drawer
			    behaviour, which now slides in from the right. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("Resize session list")}
        aria-valuenow={listWidth}
        aria-valuemin={LIST_MIN_PX}
        aria-valuemax={LIST_MAX_PX}
        tabIndex={0}
        onPointerDown={startListDrag}
        {...hoverIntent}
        onKeyDown={listDividerKeys}
        // Same line and 9px hit box as the panel's divider, leaning right to
        // stay off the editor's scrollbar.
        className="relative z-10 w-0 shrink-0 data-hover:cursor-col-resize border-l border-neutral-800 transition-colors delay-1000 duration-500 ease-out after:absolute after:inset-y-0 after:-left-0.75 after:-right-1.5 after:content-[''] data-hover:border-amber-600 data-hover:delay-0 data-hover:duration-100 focus-visible:border-amber-500 focus-visible:outline-none motion-reduce:transition-none narrow:hidden"
      />
      <SessionList
        width={listWidth}
        sessions={shown}
        attention={attention}
        listError={listError}
        activeFile={
          (focusedSide === "right" && tabs.right ? right : left).snapshot
            ?.file ?? snapshot?.file
        }
        openFiles={
          tabs.right ? [...tabs.files, ...tabs.right.files] : tabs.files
        }
        sort={sessionSort}
        pinned={pinned}
        onTogglePin={togglePin}
        onSort={changeSessionSort}
        open={listOpen}
        onToggle={() => setListOpen((o) => !o)}
        onSelect={(s) => {
          focusSession(s.path);
          // On a narrow viewport the list is a drawer over the chat; having
          // picked a session, the chat is what you want to see.
          setListOpen(false);
        }}
        onRename={(s, name) => void renameSession(s, name)}
        onAutoName={autoNameSession}
        latestPrompt={latestPrompt}
        showAttachments={sessionAttachments}
        onSearch={() => setSearchOpen(true)}
        project={project}
      />

      <SessionSearch
        open={searchOpen}
        project={project}
        sessions={shown}
        latestPrompt={latestPrompt}
        onSelect={(s) => {
          focusSession(s.path);
          setListOpen(false);
        }}
        onClose={() => setSearchOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
      />

      <WorkoutCard />

      <PageDialog
        page={page}
        onClose={() => setPage(null)}
        render={renderPage}
      />
    </div>
  );
}
