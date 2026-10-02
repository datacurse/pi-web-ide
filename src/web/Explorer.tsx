/**
 * Explorer.tsx — the file tree, as a rail panel.
 *
 * Only the tree. Opening a file does not open an editor here: it adds a tab to
 * the one strip the chat sessions live in, the way VS Code's explorer does,
 * and the tab renders FileEditor. That split is the whole point — the tree is
 * a place you browse from, not a container that owns your open files, so
 * closing this panel must not close what you opened.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
} from "react";
import {
  ArrowElbowDownRight,
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  CaretDown,
  CaretRight,
  ChatText,
  Clipboard,
  Copy,
  DownloadSimple,
  File as FileIcon,
  FilePlus,
  FolderPlus,
  GitDiff,
  Path,
  PencilSimple,
  Scissors,
  SquareSplitHorizontal,
  TerminalWindow,
  Trash,
} from "@phosphor-icons/react";
import type { PiwFileEntry } from "../shared/types.js";
import { FileGlyph } from "./fileIcon.js";
import { readExplorerOpen, writeExplorerOpen } from "./prefs.js";
import {
  ContextMenu,
  ListRow,
  MenuItem,
  MenuSeparator,
  PanelHeader,
  StripCell,
  inputClass,
} from "./ui.js";
import { api, unwrap } from "./api.js";
import { locale, plural, t } from "./i18n.js";
import { ScrollPane } from "./OverlayScrollbar.js";
import { uploadFile } from "./Attachments.js";
import { statusStyle } from "./SourceControl.js";
import { GIT_CHANGED } from "./GitActions.js";

/** Rows dragged within the tree; the data is their paths, as JSON. */
const PATH_DRAG_TYPE = "application/x-pwi-path";
/** The rows being dragged, since drag data cannot be read during dragover. */
let dragged: string[] | null = null;

/** Expand All stops after this many folders, so a huge repo cannot flood the panel. */
const EXPAND_ALL_CAP = 200;

/** Drop paths inside another of the paths: moving or deleting the folder covers them. */
const topmost = (paths: string[]) =>
  paths.filter((p) => !paths.some((q) => p.startsWith(`${q}/`)));

/** Git's porcelain status by project-relative path; a folder carries its contents'. */
type GitMarks = {
  files: Map<string, string>;
  dirs: Map<string, string>;
  untracked: string[];
};

function gitMarks(changes: { status: string; path: string }[]): GitMarks {
  const marks: GitMarks = { files: new Map(), dirs: new Map(), untracked: [] };
  // A folder takes its contents' colour, or modified's when they differ.
  const addDir = (dir: string, status: string) => {
    const had = marks.dirs.get(dir);
    marks.dirs.set(
      dir,
      !had || statusStyle(had).tone === statusStyle(status).tone
        ? status
        : " M",
    );
  };
  const up = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  for (const { status, path } of changes) {
    // A wholly untracked folder is one entry, `dir/`, standing for everything in it.
    const own = path.replace(/\/$/, "");
    if (own !== path) {
      marks.untracked.push(own);
      addDir(own, status);
    } else marks.files.set(own, status);
    for (let d = up(own); d; d = up(d)) addDir(d, status);
  }
  return marks;
}

/** Git's status for a row, by its project-relative path. */
function gitStatus(
  marks: GitMarks,
  rel: string,
  dir: boolean,
): string | undefined {
  const own = (dir ? marks.dirs : marks.files).get(rel);
  return (
    own ??
    (marks.untracked.some((d) => rel.startsWith(`${d}/`)) ? "??" : undefined)
  );
}

/** What every row reads from the panel, at any depth. */
const TreeContext = createContext<{
  cwd: string;
  /** The folder a drag would drop into. */
  dropDir: string | null;
  /** Rows picked with Ctrl- or Shift-click. */
  marked: Set<string>;
  /** Apply a click's Ctrl/Shift selection; true when that was all the click did. */
  pick: (path: string, e: MouseEvent) => boolean;
  dragStart: (path: string, e: DragEvent) => void;
  git: GitMarks;
}>({
  cwd: "",
  dropDir: null,
  marked: new Set(),
  pick: () => false,
  dragStart: () => {},
  git: gitMarks([]),
});

/** A row's background: drop target, then picked. */
function rowBg(
  tree: { dropDir: string | null; marked: Set<string> },
  path: string,
): string {
  if (tree.dropDir === path) return "bg-neutral-800";
  return tree.marked.has(path) ? "bg-amber-950/60" : "";
}

/** Bytes in the largest unit that keeps the number above 1, localised. */
function formatBytes(n: number): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return new Intl.NumberFormat(locale(), {
    style: "unit",
    unit: units[i],
    unitDisplay: "short",
    maximumFractionDigits: i && n < 10 ? 1 : 0,
  }).format(n);
}

/** A time left in whole seconds, then minutes, then hours, never under the real one. */
function formatDuration(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const [value, unit] =
    s < 60
      ? [s, "second"]
      : s < 3600
        ? [Math.ceil(s / 60), "minute"]
        : [Math.ceil(s / 3600), "hour"];
  return new Intl.NumberFormat(locale(), {
    style: "unit",
    unit,
    unitDisplay: "long",
  }).format(value);
}

/** A file dropped from outside the browser, with its path under the drop folder. */
type Dropped = { file: File; name: string };

/** Every file under a dropped entry, walking into folders. */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: Dropped[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) =>
      (entry as FileSystemFileEntry).file(res, rej),
    );
    out.push({ file, name: prefix + entry.name });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries answers in batches; an empty one is the end.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) =>
        reader.readEntries(res, rej),
      );
      if (!batch.length) break;
      for (const child of batch)
        await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}

/*
 * Directory listings, kept for the life of the page.
 *
 * Without this every mount (panel reopen, project switch) starts each node
 * empty, and the restored tree unfolds one round trip per depth level. With
 * it a node renders its last known listing immediately and revalidates in the
 * background. `inflight` dedupes the prefetch in Explorer against a node's own
 * fetch for the same directory.
 */
const listings = new Map<string, PiwFileEntry[]>();
const inflight = new Map<string, Promise<PiwFileEntry[]>>();

function listDir(path: string): Promise<PiwFileEntry[]> {
  let p = inflight.get(path);
  if (!p) {
    p = unwrap(api.files.$get({ query: { path } }))
      .then((r) => {
        listings.set(path, r.entries);
        return r.entries;
      })
      .finally(() => inflight.delete(path));
    inflight.set(path, p);
  }
  return p;
}

/** Right-click on a row: open the panel's menu for that entry. */
type RowMenu = (entry: PiwFileEntry, e: MouseEvent<HTMLButtonElement>) => void;

/** `path` relative to the project, which is how prompts and shells name it. */
function relativePath(cwd: string, path: string): string {
  if (path === cwd) return ".";
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** The folder holding `path`. */
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

/** A name being typed in the tree: a new entry inside `parent`, or a rename. */
type NameEdit =
  | { kind: "file" | "folder"; parent: string }
  | { kind: "rename"; path: string; name: string; dir: boolean };

/**
 * The edit in progress, read by whichever row it belongs to. Context rather
 * than props because it is needed at one row at any depth, and threading it
 * through every node would re-render the whole tree per keystroke.
 */
const EditContext = createContext<{
  edit: NameEdit | null;
  done: (name: string | null) => void;
}>({
  edit: null,
  done: () => {},
});

/**
 * The inline name field, in the row's own place and indent. Enter or leaving
 * the field commits; Escape cancels. A rename selects the name without its
 * extension, as VS Code does, since that is the part usually changed.
 */
function NameRow({
  depth,
  dir,
  initial,
}: {
  depth: number;
  dir: boolean;
  initial: string;
}) {
  const { done } = useContext(EditContext);
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const finish = (name: string | null) => {
    if (finished.current) return;
    finished.current = true;
    done(name?.trim() || null);
  };
  useEffect(() => {
    const dot = initial.lastIndexOf(".");
    field.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <div
      className="flex items-center gap-1.5 py-0.5 pr-3"
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <span
        className="flex w-4 shrink-0 justify-center text-neutral-500"
        aria-hidden
      >
        {dir ? <CaretRight size={14} /> : <FileGlyph name={value} />}
      </span>
      <input
        ref={field}
        autoFocus
        aria-label={dir ? t("Folder name") : t("File name")}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(value);
          else if (e.key === "Escape") finish(null);
        }}
        onBlur={() => finish(value)}
        className={`min-w-0 flex-1 ${inputClass.sm}`}
      />
    </div>
  );
}

/**
 * One expandable directory.
 *
 * Children are fetched on first expand and then kept: collapsing is a display
 * state, and re-fetching a directory the user is toggling open and shut would
 * be a request per click for a listing that has almost certainly not changed.
 */
function TreeDir({
  entry,
  depth,
  openPath,
  onOpen,
  openDirs,
  onToggle,
  onMenu,
  rev,
}: {
  entry: PiwFileEntry;
  depth: number;
  openPath: string | null;
  onOpen: (path: string) => void;
  /** Every expanded directory, by absolute path. Owned by Explorer. */
  openDirs: Set<string>;
  onToggle: (path: string) => void;
  onMenu: RowMenu;
  /** Changes when the tree should be re-read from disk. */
  rev: string;
}) {
  const [children, setChildren] = useState<PiwFileEntry[] | null>(
    () => listings.get(entry.path) ?? null,
  );
  /** The `rev` last fetched at: revalidated once per mount and per refresh. */
  const [fetched, setFetched] = useState<string | null>(null);
  /*
   * Expansion is the PANEL's state, not this node's.
   *
   * Held locally it could not be restored: a node only exists once its parent
   * has been expanded and its listing has arrived, so there is no moment at
   * which anything could hand it back a remembered flag. Reading it from a
   * set the panel owns means a node knows whether it is open the instant it
   * mounts, at any depth.
   */
  const open = openDirs.has(entry.path);

  /*
   * Children are fetched the first time the node is open in this mount,
   * which covers both the click and the restore — a restored directory
   * mounts already open and has to fetch without anyone having clicked it.
   * A cached listing shows meanwhile, so the restore is instant.
   *
   * Once per mount, then kept: collapsing is a display state, and
   * re-fetching a directory being toggled open and shut would be a request
   * per click for a listing that has almost certainly not changed.
   */
  useEffect(() => {
    if (!open || fetched === rev) return;
    let live = true;
    void listDir(entry.path)
      .then((entries) => {
        if (live) setChildren(entries);
      })
      // An unreadable directory collapses to empty rather than breaking the
      // tree: a permissions error on one folder should not cost the panel.
      .catch(() => {
        if (live) setChildren((c) => c ?? []);
      })
      .finally(() => {
        if (live) setFetched(rev);
      });
    return () => {
      live = false;
    };
  }, [open, fetched, rev, entry.path]);

  const { edit } = useContext(EditContext);
  const tree = useContext(TreeContext);
  const status = gitStatus(tree.git, relativePath(tree.cwd, entry.path), true);
  const renaming = edit?.kind === "rename" && edit.path === entry.path;
  const adding =
    edit && edit.kind !== "rename" && edit.parent === entry.path ? edit : null;

  return (
    <>
      {renaming ? (
        <NameRow depth={depth} dir initial={entry.name} />
      ) : (
        <ListRow
          onClick={(e) => {
            if (!tree.pick(entry.path, e)) onToggle(entry.path);
          }}
          data-path={entry.path}
          data-dir=""
          draggable
          onDragStart={(e) => tree.dragStart(entry.path, e)}
          onContextMenu={(e) => onMenu(entry, e)}
          className={rowBg(tree, entry.path)}
          muted={entry.hidden}
          size="body"
          aria-expanded={open}
          style={{ paddingLeft: `${depth * 12 + 4}px`, paddingRight: 0 }}
        >
          {/* A 16px slot, the width of a file's icon, so names line up the way
					    VS Code's do: Seti has no folder icons, the chevron stands in. */}
          <span
            className="flex w-4 shrink-0 justify-center text-neutral-500"
            aria-hidden
          >
            {open ? <CaretDown size={14} /> : <CaretRight size={14} />}
          </span>
          <span
            className={`fade-edge min-w-0 flex-1 ${status ? statusStyle(status).tone : ""}`}
          >
            {entry.name}
          </span>
        </ListRow>
      )}
      {open && adding && (
        <NameRow depth={depth + 1} dir={adding.kind === "folder"} initial="" />
      )}
      {open &&
        children?.map((child) =>
          child.dir ? (
            <TreeDir
              key={child.path}
              entry={child}
              depth={depth + 1}
              openPath={openPath}
              onOpen={onOpen}
              openDirs={openDirs}
              onToggle={onToggle}
              onMenu={onMenu}
              rev={rev}
            />
          ) : (
            <TreeFile
              key={child.path}
              entry={child}
              depth={depth + 1}
              active={child.path === openPath}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          ),
        )}
    </>
  );
}

function TreeFile({
  entry,
  depth,
  active,
  onOpen,
  onMenu,
}: {
  entry: PiwFileEntry;
  depth: number;
  active: boolean;
  onOpen: (path: string) => void;
  onMenu: RowMenu;
}) {
  const { edit } = useContext(EditContext);
  const tree = useContext(TreeContext);
  if (edit?.kind === "rename" && edit.path === entry.path) {
    return <NameRow depth={depth} dir={false} initial={entry.name} />;
  }
  const status = gitStatus(tree.git, relativePath(tree.cwd, entry.path), false);
  const mark = status ? statusStyle(status) : null;
  return (
    <ListRow
      onClick={(e) => {
        if (!tree.pick(entry.path, e)) onOpen(entry.path);
      }}
      data-path={entry.path}
      draggable
      onDragStart={(e) => tree.dragStart(entry.path, e)}
      onContextMenu={(e) => onMenu(entry, e)}
      className={rowBg(tree, entry.path)}
      selected={active}
      muted={entry.hidden}
      size="body"
      // Same indent as a sibling directory: the icon takes the chevron's slot.
      style={{ paddingLeft: `${depth * 12 + 4}px`, paddingRight: 0 }}
    >
      <FileGlyph name={entry.name} />
      <span className={`fade-edge min-w-0 flex-1 ${mark?.tone ?? ""}`}>
        {entry.name}
      </span>
      {mark && (
        <span className={`shrink-0 pr-3 font-mono text-meta ${mark.tone}`}>
          {mark.letter}
        </span>
      )}
    </ListRow>
  );
}

export function Explorer({
  cwd,
  openPath,
  onOpen,
  onOpenSide,
  onOpenDiff,
  onOpenTerminal,
  onAddToChat,
  onPathChange,
  hasUnsaved,
  reveal,
  onRevealed,
  onClose,
  revision,
  children,
}: {
  cwd: string;
  /** Changes when something may have touched the tree; re-reads it. */
  revision: number;
  /** Rendered under the header: the project picker. */
  children?: React.ReactNode;
  /** The file showing in the active tab, highlighted in the tree. */
  openPath: string | null;
  /** Open this file in a tab. */
  onOpen: (path: string) => void;
  /** Open this file in the second column, splitting if needed. */
  onOpenSide: (path: string) => void;
  /** Open a diff tab: `ref` empty is the working tree, `path` project-relative. */
  onOpenDiff: (ref: string, path: string) => void;
  /** A new terminal starting in this directory; absent with no project. */
  onOpenTerminal?: (dir: string) => Promise<void>;
  /** Append text to the open session's composer; absent when none is open. */
  onAddToChat?: (text: string) => void;
  /** A path was renamed to `to`, or deleted (null): open tabs follow. */
  onPathChange: (from: string, to: string | null) => void;
  /** Unsaved edits at or under a path; renaming or deleting it is refused. */
  hasUnsaved: (path: string) => boolean;
  /** A file to expand down to and scroll into view; `onRevealed` clears it. */
  reveal?: string | null;
  onRevealed?: () => void;
  onClose: () => void;
}) {
  const [roots, setRoots] = useState<PiwFileEntry[]>(
    () => listings.get(cwd) ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  /** Bumped after a file operation, to re-read the tree. */
  const [manual, setManual] = useState(0);
  const rev = `${revision}:${manual}`;
  /** Bumped after a commit or push, which changes git's view but not the files. */
  const [gitRev, setGitRev] = useState(0);
  /*
   * The expanded directories, restored per project. App keys this panel on
   * `cwd`, so a project switch remounts it and the lazy initialisers (this,
   * `roots`, every node's children) read the new project's state on the
   * first render, with no frame of the previous project's tree.
   */
  const [openDirs, setOpenDirs] = useState<Set<string>>(
    () => new Set(readExplorerOpen(cwd)),
  );
  /** `root`: opened on the empty area below the rows, acting on the project itself. */
  /** `targets`: the paths it acts on, several when opened on a picked row. */
  const [menu, setMenu] = useState<{
    entry: PiwFileEntry;
    targets: string[];
    x: number;
    y: number;
    root?: boolean;
  } | null>(null);
  const [edit, setEdit] = useState<NameEdit | null>(null);
  /** Cut or copied, waiting for Paste. Cut is a move, so it is used up by one paste. */
  const [clip, setClip] = useState<{ paths: string[]; cut: boolean } | null>(
    null,
  );
  /** Git's changes in the project, re-read with the tree. */
  const [changes, setChanges] = useState<{ status: string; path: string }[]>(
    [],
  );
  const git = useMemo(() => gitMarks(changes), [changes]);
  /** An error to show once the refresh that follows it has re-read the tree. */
  const afterRefresh = useRef<string | null>(null);
  /** The folder under a drag in progress, or null. */
  const [dropDir, setDropDir] = useState<string | null>(null);
  /** Rows picked with Ctrl- or Shift-click; a plain click clears them. */
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  /** The last clicked row, where a Shift-click range starts. */
  const anchor = useRef<string | null>(null);
  /** An upload in progress; `shown` once it looks like taking over a second. */
  const [transfer, setTransfer] = useState<{
    id: number;
    count: number;
    total: number;
    sent: number;
    started: number;
    shown: boolean;
  } | null>(null);

  const openMenu = useCallback<RowMenu>(
    (entry, e) => {
      e.preventDefault();
      const targets = marked.has(entry.path)
        ? topmost([...marked])
        : [entry.path];
      if (!marked.has(entry.path)) setMarked(new Set());
      // A keyboard-raised menu reports (0,0); anchor it to the row instead.
      const box = e.currentTarget.getBoundingClientRect();
      setMenu({
        entry,
        targets,
        x: e.clientX || box.left + 16,
        y: e.clientY || box.bottom,
      });
    },
    [marked],
  );

  /** Run a menu action, closing the menu first. */
  const act = (fn: () => void | Promise<void>) => () => {
    setMenu(null);
    void Promise.resolve()
      .then(fn)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  };

  // Fetch every remembered open directory at once, so a cold restore is one
  // round trip instead of one per depth level. Nodes pick these up through
  // listDir's in-flight dedupe. Errors are the node's to handle.
  useEffect(() => {
    for (const p of readExplorerOpen(cwd)) listDir(p).catch(() => {});
  }, [cwd]);

  const toggleDir = useCallback(
    (path: string) => {
      setOpenDirs((prev) => {
        const next = new Set(prev);
        if (!next.delete(path)) next.add(path);
        // Written here rather than in an effect on `openDirs`: the effect
        // would also fire for the restore above, writing a project's
        // remembered set straight back over itself on every switch.
        writeExplorerOpen(cwd, [...next]);
        return next;
      });
    },
    [cwd],
  );

  const tree = useRef<HTMLDivElement>(null);

  const collapseAll = () => {
    setOpenDirs(new Set());
    writeExplorerOpen(cwd, []);
  };

  /** Open every folder, level by level, up to EXPAND_ALL_CAP; hidden ones stay shut. */
  const expandAll = async () => {
    const found: string[] = [];
    for (let level = [cwd]; level.length && found.length < EXPAND_ALL_CAP;) {
      const lists = await Promise.all(
        level.map((d) => listDir(d).catch(() => [])),
      );
      level = lists
        .flat()
        .filter((e) => e.dir && !e.hidden)
        .map((e) => e.path)
        .slice(0, EXPAND_ALL_CAP - found.length);
      found.push(...level);
    }
    setOpenDirs((prev) => {
      const next = new Set([...prev, ...found]);
      writeExplorerOpen(cwd, [...next]);
      return next;
    });
  };

  /*
   * Selection keys on a row click. Ctrl (Cmd) toggles one row, Shift picks
   * every visible row between the last clicked and this one. A plain click
   * clears the picks and does the row's usual thing.
   */
  const pick = (path: string, e: MouseEvent) => {
    if (e.shiftKey && anchor.current && tree.current) {
      const rows = [
        ...tree.current.querySelectorAll<HTMLElement>("[data-path]"),
      ].map((r) => r.dataset.path);
      const a = rows.indexOf(anchor.current);
      const b = rows.indexOf(path);
      if (a >= 0 && b >= 0) {
        setMarked(
          new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1) as string[]),
        );
        return true;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      // The first Ctrl-click also keeps the row clicked before it, as VS Code does.
      const from = anchor.current;
      setMarked((prev) => {
        const next = new Set(prev.size || !from ? prev : [from]);
        if (!next.delete(path)) next.add(path);
        return next;
      });
      anchor.current = path;
      return true;
    }
    anchor.current = path;
    if (marked.size) setMarked(new Set());
    return false;
  };

  /** Dragging a picked row drags every picked row. */
  const dragStart = (path: string, e: DragEvent) => {
    const paths = marked.has(path) ? topmost([...marked]) : [path];
    dragged = paths;
    e.dataTransfer.setData(PATH_DRAG_TYPE, JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "move";
  };

  /*
   * Reveal: open every folder between the project and the file, then wait
   * for its row. The rows arrive as each folder's listing loads, so this
   * watches the tree for the row rather than guessing how long that takes.
   */
  useEffect(() => {
    const el = tree.current;
    if (!reveal || !el) return;
    const done = () => onRevealed?.();
    if (!reveal.startsWith(`${cwd}/`)) return done();
    const dirs: string[] = [];
    for (let p = parentOf(reveal); p.length > cwd.length; p = parentOf(p))
      dirs.push(p);
    setOpenDirs((prev) => {
      if (dirs.every((d) => prev.has(d))) return prev;
      const next = new Set([...prev, ...dirs]);
      writeExplorerOpen(cwd, [...next]);
      return next;
    });
    const find = () =>
      el.querySelector<HTMLElement>(`[data-path="${CSS.escape(reveal)}"]`);
    const show = (row: HTMLElement) => {
      row.scrollIntoView({ block: "center" });
      row.focus({ preventScroll: true });
      done();
    };
    const now = find();
    if (now) return show(now);
    const watch = new MutationObserver(() => {
      const row = find();
      if (row) show(row);
    });
    watch.observe(el, { childList: true, subtree: true });
    // A file the tree skips (under node_modules, say) never gets a row.
    const giveUp = setTimeout(done, 5000);
    return () => {
      watch.disconnect();
      clearTimeout(giveUp);
    };
    // `onRevealed` is a fresh closure each render; `reveal` is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, cwd]);

  const refresh = () => setManual((n) => n + 1);
  const fail = (err: unknown) =>
    setError(err instanceof Error ? err.message : String(err));
  const guard = (path: string) => {
    if (hasUnsaved(path))
      throw new Error(t("Save or discard the unsaved edits under it first."));
  };

  /** Start a new file or folder in `parent`, opening it so the field shows. */
  const startNew = (kind: "file" | "folder", parent: string) => {
    if (parent !== cwd && !openDirs.has(parent)) toggleDir(parent);
    setEdit({ kind, parent });
  };

  /** The inline field finished: create or rename, or nothing on cancel. */
  const finishEdit = (name: string | null) => {
    const current = edit;
    setEdit(null);
    if (!current || !name) return;
    void (async () => {
      if (current.kind === "rename") {
        if (name === current.name) return;
        const to = `${parentOf(current.path)}/${name}`;
        await unwrap(
          api.files.move.$post({ json: { from: current.path, to } }),
        );
        onPathChange(current.path, to);
      } else {
        const r = await unwrap(
          api.files.create.$post({
            json: {
              path: `${current.parent}/${name}`,
              dir: current.kind === "folder",
            },
          }),
        );
        if (current.kind === "file" && r.path) onOpen(r.path);
      }
      refresh();
    })().catch(fail);
  };

  /** Paste the clipboard into `dir`: a cut moves (and is used up), a copy copies. */
  const paste = async (dir: string) => {
    if (!clip) return;
    if (clip.cut) {
      await moveInto(clip.paths, dir);
      setClip(null);
    } else {
      try {
        for (const from of clip.paths)
          await unwrap(api.files.copy.$post({ json: { from, toDir: dir } }));
      } finally {
        refresh();
      }
    }
  };

  // A drag resting on a closed folder opens it, so a deep target can be reached.
  useEffect(() => {
    if (!dropDir || dropDir === cwd || openDirs.has(dropDir)) return;
    const timer = setTimeout(() => toggleDir(dropDir), 600);
    return () => clearTimeout(timer);
  }, [dropDir, openDirs, cwd, toggleDir]);

  /** The folder a drag event points at: a folder row, a file's folder, or the project. */
  const dropTargetOf = (e: DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-path]");
    const path = row?.dataset.path;
    if (!path) return cwd;
    return row.dataset.dir === undefined ? parentOf(path) : path;
  };

  /** Whether rows may move into `dir`: none into itself, and not all already there. */
  const canMove = (paths: string[], dir: string) =>
    paths.every((p) => dir !== p && !dir.startsWith(`${p}/`)) &&
    paths.some((p) => parentOf(p) !== dir);

  const showDir = (dir: string) => {
    if (dir !== cwd && !openDirs.has(dir)) toggleDir(dir);
  };

  /** Move rows into `dir`, skipping any already there. All are checked for unsaved edits first. */
  const moveInto = async (paths: string[], dir: string) => {
    const moving = paths.filter((p) => parentOf(p) !== dir);
    for (const p of moving) guard(p);
    try {
      for (const from of moving) {
        const to = `${dir}/${from.slice(from.lastIndexOf("/") + 1)}`;
        await unwrap(api.files.move.$post({ json: { from, to } }));
        onPathChange(from, to);
      }
    } finally {
      setMarked(new Set());
      refresh();
    }
    showDir(dir);
  };

  /** Upload what was dropped from outside; one failure does not stop the rest. */
  const uploadInto = async (
    sources: (FileSystemEntry | File)[],
    dir: string,
  ) => {
    const files: Dropped[] = [];
    for (const s of sources) {
      if (s instanceof File) files.push({ file: s, name: s.name });
      else await walkEntry(s, "", files);
    }
    const id = Date.now();
    const total = files.reduce((n, f) => n + f.file.size, 0);
    const sent = files.map(() => 0);
    const started = performance.now();
    setTransfer({
      id,
      count: files.length,
      total,
      sent: 0,
      started,
      shown: false,
    });
    /*
     * Shown once the upload looks like taking over a second, estimated from
     * the rate so far, or when it simply still runs at one second: a quick
     * drop never flashes a bar.
     */
    const update = (late = false) =>
      setTransfer((tr) => {
        if (tr?.id !== id) return tr;
        const now = sent.reduce((a, b) => a + b, 0);
        const took = performance.now() - started;
        const slow =
          late || (took > 200 && now > 0 && (took * total) / now - took > 1000);
        return { ...tr, sent: now, shown: tr.shown || slow };
      });
    const late = setTimeout(() => update(true), 1000);
    const results = await Promise.allSettled(
      files.map((f, i) =>
        uploadFile(f.file, { dir, name: f.name }, (n) => {
          sent[i] = n;
          update();
        }),
      ),
    ).finally(() => {
      clearTimeout(late);
      setTransfer((tr) => (tr?.id === id ? null : tr));
    });
    const errors = results.flatMap((r) =>
      r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : [],
    );
    afterRefresh.current = errors.length ? errors.join("\n") : null;
    showDir(dir);
    refresh();
  };

  const trash = async (paths: string[]) => {
    for (const p of paths) guard(p);
    const ask =
      paths.length === 1
        ? t('Move "{name}" to the Trash?', {
            name: paths[0].slice(paths[0].lastIndexOf("/") + 1),
          })
        : plural(
            paths.length,
            "Move {n} item to the Trash?",
            "Move {n} items to the Trash?",
          );
    if (!window.confirm(ask)) return;
    try {
      for (const path of paths) {
        await unwrap(api.files.trash.$post({ json: { path } }));
        onPathChange(path, null);
        setClip((c) =>
          c?.paths.some((q) => q === path || q.startsWith(`${path}/`))
            ? null
            : c,
        );
      }
    } finally {
      setMarked(new Set());
      refresh();
    }
  };

  useEffect(() => {
    if (!cwd) return;
    let live = true;
    // Not a repo, or git failed: no colours and no "Open Changes", nothing else lost.
    void unwrap(api.git.changes.$get({ query: { cwd } }))
      .then((r) => live && setChanges(r.files))
      .catch(() => live && setChanges([]));
    return () => {
      live = false;
    };
  }, [cwd, rev, gitRev]);

  useEffect(() => {
    const on = () => setGitRev((n) => n + 1);
    window.addEventListener(GIT_CHANGED, on);
    return () => window.removeEventListener(GIT_CHANGED, on);
  }, []);

  /*
   * Re-read the tree when something changes on disk in the project folder or
   * an open one: the server watches those (not the whole repo) and says so.
   * Reconnects when folders open or close, which is cheap.
   */
  useEffect(() => {
    if (!cwd) return;
    const q = new URLSearchParams({ root: cwd });
    for (const d of openDirs)
      if (d.startsWith(`${cwd}/`)) q.append("dir", d.slice(cwd.length + 1));
    const events = new EventSource(`/api/files/watch?${q}`);
    events.onmessage = () => setManual((n) => n + 1);
    return () => events.close();
  }, [cwd, openDirs]);

  useEffect(() => {
    if (!cwd) return;
    let live = true;
    void listDir(cwd)
      .then((entries) => {
        if (!live) return;
        setRoots(entries);
        setError(afterRefresh.current);
        afterRefresh.current = null;
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, [cwd, rev]);

  return (
    <section
      aria-label={t("Explorer")}
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950"
    >
      <PanelHeader title={t("Explorer")} onClose={onClose} cells>
        <StripCell
          onClick={() => void expandAll().catch(fail)}
          label={t("Expand all folders")}
        >
          <ArrowsOutLineVertical size={16} />
        </StripCell>
        <StripCell onClick={collapseAll} label={t("Collapse all folders")}>
          <ArrowsInLineVertical size={16} />
        </StripCell>
      </PanelHeader>
      {children}

      {error && (
        <div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-meta whitespace-pre-line text-red-300">
          {error}
        </div>
      )}

      <EditContext.Provider value={{ edit, done: finishEdit }}>
        <TreeContext.Provider
          value={{ cwd, dropDir, marked, pick, dragStart, git }}
        >
          <ScrollPane
            ref={tree}
            className="min-h-0 flex-1"
            innerClassName={`py-1 ${dropDir === cwd ? "bg-neutral-900" : ""}`}
            // Drops: a row from this tree moves; files from outside are uploaded.
            onDragOver={(e) => {
              const internal = e.dataTransfer.types.includes(PATH_DRAG_TYPE);
              if (!internal && !e.dataTransfer.types.includes("Files")) return;
              const dir = dropTargetOf(e);
              if (internal && (!dragged || !canMove(dragged, dir)))
                return setDropDir(null);
              // A drop from outside while a pick is showing is about neither.
              if (!internal && marked.size) setMarked(new Set());
              e.preventDefault();
              e.dataTransfer.dropEffect = internal ? "move" : "copy";
              setDropDir(dir);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                setDropDir(null);
            }}
            onDragEnd={() => {
              dragged = null;
              setDropDir(null);
            }}
            onDrop={(e) => {
              setDropDir(null);
              const dir = dropTargetOf(e);
              const raw = e.dataTransfer.getData(PATH_DRAG_TYPE);
              if (raw) {
                e.preventDefault();
                const paths = dragged;
                dragged = null;
                if (paths && canMove(paths, dir))
                  void moveInto(paths, dir).catch(fail);
                return;
              }
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              // Entries must be taken now: the list is emptied once this handler returns.
              const sources = [...e.dataTransfer.items]
                .filter((i) => i.kind === "file")
                .map((i) => i.webkitGetAsEntry() ?? i.getAsFile())
                .filter((s): s is FileSystemEntry | File => s !== null);
              void uploadInto(sources, dir).catch(fail);
            }}
            // The empty space below the rows: a menu for the project itself.
            onContextMenu={(e) => {
              if (e.target !== e.currentTarget) return;
              e.preventDefault();
              setMarked(new Set());
              const name = cwd.slice(cwd.lastIndexOf("/") + 1);
              const entry = { name, path: cwd, dir: true, hidden: false };
              setMenu({
                entry,
                targets: [cwd],
                x: e.clientX,
                y: e.clientY,
                root: true,
              });
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget && marked.size)
                setMarked(new Set());
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && marked.size) setMarked(new Set());
            }}
          >
            {edit && edit.kind !== "rename" && edit.parent === cwd && (
              <NameRow depth={0} dir={edit.kind === "folder"} initial="" />
            )}
            {roots.map((entry) =>
              entry.dir ? (
                <TreeDir
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  openPath={openPath}
                  onOpen={onOpen}
                  openDirs={openDirs}
                  onToggle={toggleDir}
                  onMenu={openMenu}
                  rev={rev}
                />
              ) : (
                <TreeFile
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  active={entry.path === openPath}
                  onOpen={onOpen}
                  onMenu={openMenu}
                />
              ),
            )}
          </ScrollPane>
        </TreeContext.Provider>
      </EditContext.Provider>

      {transfer?.shown &&
        (() => {
          const { count, total, sent, started } = transfer;
          const took = performance.now() - started;
          const left =
            sent >= total
              ? t("finishing…")
              : sent > 0
                ? t("{time} left", {
                    time: formatDuration(((total - sent) * took) / sent),
                  })
                : "";
          const parts = [
            plural(count, "Uploading {n} file", "Uploading {n} files"),
            t("{sent} of {total}", {
              sent: formatBytes(sent),
              total: formatBytes(total),
            }),
            left,
          ];
          return (
            <div
              role="status"
              className="border-t border-neutral-800 px-3 py-2 text-meta text-neutral-400"
            >
              {parts.filter(Boolean).join(" · ")}
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-neutral-800">
                <div
                  className="h-full rounded-full bg-amber-400"
                  style={{ width: `${total ? (sent / total) * 100 : 100}%` }}
                />
              </div>
            </div>
          );
        })()}

      {menu &&
        (() => {
          const m = menu.entry;
          const dir = m.dir ? m.path : parentOf(m.path);
          const targets = menu.targets;
          /** Opened on several picked rows: only what applies to all of them at once. */
          const many = targets.length > 1;
          const clipName = clip
            ? clip.paths.length === 1
              ? clip.paths[0].slice(clip.paths[0].lastIndexOf("/") + 1)
              : plural(clip.paths.length, "{n} item", "{n} items")
            : "";
          return (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              label={
                many ? plural(targets.length, "{n} item", "{n} items") : m.name
              }
              onClose={() => setMenu(null)}
            >
              {many ? null : m.dir ? (
                <>
                  <MenuItem
                    icon={<FilePlus size={16} />}
                    role="menuitem"
                    autoFocus
                    onClick={act(() => startNew("file", m.path))}
                  >
                    {t("New File…")}
                  </MenuItem>
                  <MenuItem
                    icon={<FolderPlus size={16} />}
                    role="menuitem"
                    onClick={act(() => startNew("folder", m.path))}
                  >
                    {t("New Folder…")}
                  </MenuItem>
                </>
              ) : (
                <>
                  <MenuItem
                    icon={<FileIcon size={16} />}
                    role="menuitem"
                    autoFocus
                    onClick={act(() => onOpen(m.path))}
                  >
                    {t("Open")}
                  </MenuItem>
                  <MenuItem
                    icon={<SquareSplitHorizontal size={16} />}
                    role="menuitem"
                    onClick={act(() => onOpenSide(m.path))}
                  >
                    {t("Open to the Side")}
                  </MenuItem>
                  {git.files.has(relativePath(cwd, m.path)) && (
                    <MenuItem
                      icon={<GitDiff size={16} />}
                      role="menuitem"
                      onClick={act(() =>
                        onOpenDiff("", relativePath(cwd, m.path)),
                      )}
                    >
                      {t("Open Changes")}
                    </MenuItem>
                  )}
                </>
              )}
              {!many && <MenuSeparator />}
              {!menu.root && (
                <MenuItem
                  icon={<ChatText size={16} />}
                  role="menuitem"
                  autoFocus={many}
                  disabled={!onAddToChat}
                  title={onAddToChat ? undefined : t("Open a session first")}
                  onClick={act(() =>
                    onAddToChat?.(
                      targets.map((p) => relativePath(cwd, p)).join(" "),
                    ),
                  )}
                >
                  {t("Add to Chat")}
                </MenuItem>
              )}
              {!many && (
                <MenuItem
                  icon={<TerminalWindow size={16} />}
                  role="menuitem"
                  disabled={!onOpenTerminal}
                  onClick={act(() => onOpenTerminal?.(dir))}
                >
                  {t("Open in Terminal")}
                </MenuItem>
              )}
              {!m.dir && !many && (
                <MenuItem
                  icon={<DownloadSimple size={16} />}
                  role="menuitem"
                  onClick={act(() => {
                    const a = document.createElement("a");
                    a.href = `/api/download?path=${encodeURIComponent(m.path)}`;
                    a.download = m.name;
                    a.click();
                  })}
                >
                  {t("Download")}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem
                icon={<Path size={16} />}
                role="menuitem"
                onClick={act(() =>
                  navigator.clipboard.writeText(targets.join("\n")),
                )}
              >
                {t("Copy Path")}
              </MenuItem>
              {!menu.root && (
                <MenuItem
                  icon={<ArrowElbowDownRight size={16} />}
                  role="menuitem"
                  onClick={act(() =>
                    navigator.clipboard.writeText(
                      targets.map((p) => relativePath(cwd, p)).join("\n"),
                    ),
                  )}
                >
                  {t("Copy Relative Path")}
                </MenuItem>
              )}
              <MenuSeparator />
              {!menu.root && (
                <>
                  <MenuItem
                    icon={<Scissors size={16} />}
                    role="menuitem"
                    onClick={act(() => setClip({ paths: targets, cut: true }))}
                  >
                    {t("Cut")}
                  </MenuItem>
                  <MenuItem
                    icon={<Copy size={16} />}
                    role="menuitem"
                    onClick={act(() => setClip({ paths: targets, cut: false }))}
                  >
                    {t("Copy")}
                  </MenuItem>
                </>
              )}
              {!many && (
                <MenuItem
                  icon={<Clipboard size={16} />}
                  role="menuitem"
                  disabled={!clip}
                  title={
                    clip
                      ? t("Paste {name} into {dir}", {
                          name: clipName,
                          dir: relativePath(cwd, dir),
                        })
                      : undefined
                  }
                  onClick={act(() => paste(dir))}
                >
                  {t("Paste")}
                </MenuItem>
              )}
              {!menu.root && (
                <>
                  <MenuSeparator />
                  {!many && (
                    <MenuItem
                      icon={<PencilSimple size={16} />}
                      role="menuitem"
                      onClick={act(() => {
                        guard(m.path);
                        setEdit({
                          kind: "rename",
                          path: m.path,
                          name: m.name,
                          dir: m.dir,
                        });
                      })}
                    >
                      {t("Rename…")}
                    </MenuItem>
                  )}
                  <MenuItem
                    icon={<Trash size={16} />}
                    role="menuitem"
                    onClick={act(() => trash(targets))}
                  >
                    {t("Delete")}
                  </MenuItem>
                </>
              )}
            </ContextMenu>
          );
        })()}
    </section>
  );
}
