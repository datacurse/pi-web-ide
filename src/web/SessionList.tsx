import { useMemo, useState } from "react";
import {
  ArrowsOut,
  CaretUpDown,
  ChatCircle,
  Clock,
  Eye,
  EyeSlash,
  FileText,
  MagnifyingGlass,
  PushPin,
  X,
} from "@phosphor-icons/react";
import type { PiSessionInfo } from "../shared/types.js";
import {
  SESSION_SORTS,
  readHiddenSessions,
  writeHiddenSessions,
  type SessionSort,
} from "./prefs.js";
import { sessionLabel, shortName } from "./sessionName.js";
import { ATTENTION_UI, attentionRank, type Attention } from "./attention.js";
import { highlight, useSessionSearch } from "./searchHits.js";
import {
  Button,
  ContextMenu,
  IconButton,
  MenuItem,
  StripCell,
  inputClass,
  sectionLabel,
  useBatches,
} from "./ui.js";
import { perLocale, plural, t } from "./i18n.js";
import { ScrollPane } from "./OverlayScrollbar.js";

/** The timestamp a row shows, which is always the one it is sorted by. */
function stamp(s: PiSessionInfo, sort: SessionSort): string {
  if (sort === "asked") return s.lastAsked ?? s.created;
  return sort === "created" ? s.created : s.lastActive;
}

/** `short` drops "ago" ("20m", "now") for the session list's icon line. */
export function timeAgo(iso: string | number, short = false): string {
  const s = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (s < 60) return short ? t("now") : t("just now");
  const m = Math.floor(s / 60);
  if (m < 60) return short ? t("{n}m", { n: m }) : t("{n}m ago", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return short ? t("{n}h", { n: h }) : t("{n}h ago", { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return short ? t("{n}d", { n: d }) : t("{n}d ago", { n: d });
  const mo = Math.floor(d / 30);
  if (mo < 12) return short ? t("{n}mo", { n: mo }) : t("{n}mo ago", { n: mo });
  const y = Math.floor(mo / 12);
  return short ? t("{n}y", { n: y }) : t("{n}y ago", { n: y });
}

const dateFmt = perLocale(
  (l) =>
    new Intl.DateTimeFormat(l, {
      day: "numeric",
      month: "long",
    }),
);

/**
 * Left panel: flat, read-only list of EVERY session in the project.
 *
 * Read-only means no delete, no archive, no rename: the session file is
 * pi's, and a UI that deletes an agent's memory should have to be very sure
 * of itself. The list shows what is on disk; managing it is the TUI's job.
 *
 * One project at a time, chosen in the Explorer's project picker, which
 * keeps the 5s poll at exactly one request.
 */
export function SessionList({
  sessions,
  attention,
  listError,
  activeFile,
  openFiles,
  sort,
  onSort,
  pinned: pins,
  onTogglePin: togglePin,
  open,
  onToggle,
  onSelect,
  onRename,
  onAutoName,
  latestPrompt,
  showAttachments,
  onSearch,
  project,
  width,
}: {
  sessions: PiSessionInfo[];
  /** Each session's working / ready / needs state, keyed by file. */
  attention: Map<string, Attention>;
  /** Why the listing failed, when it did; shown instead of "No sessions yet". */
  listError: string | null;
  activeFile: string | undefined;
  /** Sessions that already have a tab; clicking one just focuses it. */
  openFiles: string[];
  sort: SessionSort;
  onSort: (sort: SessionSort) => void;
  /** Pinned session paths, shared with the tab strips. */
  pinned: string[];
  onTogglePin: (path: string) => void;
  /** Drawer state. Only observable at <=768px, where this is an overlay. */
  open: boolean;
  onToggle: () => void;
  onSelect: (s: PiSessionInfo) => void;
  /** Rename one session. pi owns the name, so this is a server round trip. */
  onRename: (s: PiSessionInfo, name: string) => void;
  /**
   * Hand the naming to the server: a one-shot `pi -p` child turns the
   * session's opening request into a title. Awaited, so the row can say it
   * is working — this one can take seconds, unlike the local derivation.
   */
  onAutoName: (s: PiSessionInfo) => Promise<void>;
  /** Label unnamed sessions by a short name from the first prompt. */
  latestPrompt: boolean;
  showAttachments: boolean;
  /** Open the search popup (also Ctrl+O). */
  onSearch: () => void;
  /** The project whose sessions the search box searches. */
  project: string;
  /** Column width in px on a wide viewport; the drawer keeps its own. */
  width: number;
}) {
  /*
   * Sorted here rather than on the server: both timestamps are already on
   * the wire, the list is small, and switching order must not wait for a
   * request. Descending in both modes — a session list is read newest-first
   * in either question it answers.
   */
  // Pinned sessions first, then the ones waiting on you (questions before
  // replies), each group in the chosen order.
  const ordered = useMemo(
    () =>
      [...sessions].sort(
        (a, b) =>
          Number(pins.includes(b.path)) - Number(pins.includes(a.path)) ||
          attentionRank(attention.get(a.path) ?? null) -
            attentionRank(attention.get(b.path) ?? null) ||
          stamp(b, sort).localeCompare(stamp(a, sort)),
      ),
    [sessions, sort, pins, attention],
  );

  /*
   * The search box filters this list in place, in the server's relevance
   * order, with each row's subline showing the matched excerpt. Rows are the
   * live session objects, so pins and state dots stay current.
   */
  const [query, setQuery] = useState("");
  const {
    hits,
    terms,
    pending,
    error: searchError,
  } = useSessionSearch(project, query);
  const searching = terms.length > 0;
  const snippets = new Map(hits.map((h) => [h.session.path, h.snippet]));
  /*
   * Hidden sessions (per browser) drop out of the list and its search. The
   * eye cell in the count row shows them again, dimmed, so they can be
   * unhidden from the same right-click menu.
   */
  const [hidden, setHidden] = useState(readHiddenSessions);
  const [showHidden, setShowHidden] = useState(false);
  const hiddenCount = sessions.filter((s) => hidden.includes(s.path)).length;
  const toggleHidden = (path: string) => {
    const next = hidden.includes(path)
      ? hidden.filter((p) => p !== path)
      : [...hidden, path];
    setHidden(next);
    writeHiddenSessions(next);
    if (!sessions.some((s) => next.includes(s.path))) setShowHidden(false);
  };
  const rows = (
    searching
      ? hits.map(
          (h) => sessions.find((s) => s.path === h.session.path) ?? h.session,
        )
      : ordered
  ).filter((s) => showHidden || !hidden.includes(s.path));
  const { shown, end, more } = useBatches(rows.length);

  /*
   * Which row is being renamed, and the text in it. Local, like the picker:
   * a half-typed name belongs to this panel and to nothing else, and nothing
   * outside it can start a rename.
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  /*
   * The open row menu: which session, and where the pointer was. Closed by
   * anything that would make its position a lie — a click, Escape, a scroll,
   * a resize — which is also every gesture that means "not this".
   */
  const [menu, setMenu] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  /** The row waiting on a generated name, so it can say so instead of looking idle. */
  const [naming, setNaming] = useState<string | null>(null);

  const menuSession = menu
    ? sessions.find((s) => s.path === menu.path)
    : undefined;

  return (
    <>
      {/* Dismiss-by-tapping-away. Pointer-only affordance by design: the
			    drawer also has a real, focusable close button. */}
      {open && (
        <div
          aria-hidden
          onClick={onToggle}
          className="fixed inset-0 z-20 bg-black/60 wide:hidden"
        />
      )}

      {/*
			  Two layouts, one element: a static column from 769px up, a fixed
			  overlay below it. `hidden wide:flex` rather than a JS media
			  query so the correct layout is in the first paint.
			*/}
      <aside
        id="session-list"
        aria-label={t("All sessions")}
        // Right edge now, opposite the activity rail: `border-l` and the
        // drawer anchored to `right-0`, or it would slide in from the side it
        // no longer lives on.
        // On wide the divider App draws is the left edge, so the border is
        // the drawer's only.
        style={{ "--list-w": `${width}px` } as React.CSSProperties}
        className={`w-(--list-w) shrink-0 flex-col border-neutral-800 narrow:border-l bg-neutral-950 narrow:fixed narrow:inset-y-0 narrow:right-0 narrow:z-30 narrow:w-[min(20rem,85vw)] narrow:shadow-2xl ${
          open ? "flex" : "hidden wide:flex"
        }`}
      >
        {/*
				  Sort mode. Two orders, one button, because a dropdown for a
				  binary choice is a click more for the same information.

				  `created` is the default and the only one that cannot move on
				  its own: it is the header timestamp, written once. Ordering by
				  file mtime — which is what this list used to do — meant a
				  session jumped to the top just from being opened, so `active`
				  reads the timestamp of the last message in the file instead.
				*/}
        <div className="flex justify-end border-b border-neutral-800 px-2 py-1.5 wide:hidden">
          <IconButton
            onClick={onToggle}
            label={t("Hide session list")}
            title={t("Hide sessions")}
          >
            <X size={13} />
          </IconButton>
        </div>

        <div className="flex h-bar shrink-0 items-stretch border-b border-neutral-800">
          <label className="flex min-w-0 flex-1 cursor-text items-center gap-2 px-3">
            <MagnifyingGlass size={16} className="shrink-0 text-neutral-500" />
            <input
              data-custom="search field"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              placeholder={t("Search sessions")}
              aria-label={t("Search sessions")}
              className="min-w-0 flex-1 bg-transparent text-ui text-neutral-100 outline-none placeholder:text-neutral-500"
            />
          </label>
          <StripCell
            onClick={onSearch}
            label={t("Open search window (Ctrl+O)")}
          >
            <ArrowsOut size={16} />
          </StripCell>
        </div>

        <div className="flex h-bar shrink-0 items-stretch border-b border-neutral-800">
          <span className={`min-w-0 flex-1 self-center pl-3 ${sectionLabel}`}>
            {pending
              ? t("Searching…")
              : searching
                ? plural(rows.length, "{n} match", "{n} matches")
                : plural(rows.length, "{n} session", "{n} sessions")}
          </span>
          {hiddenCount > 0 && (
            <StripCell
              onClick={() => setShowHidden((v) => !v)}
              aria-pressed={showHidden}
              label={
                showHidden
                  ? t("Leave out hidden sessions")
                  : plural(
                      hiddenCount,
                      "Show {n} hidden session",
                      "Show {n} hidden sessions",
                    )
              }
            >
              {showHidden ? (
                <Eye size={16} className="text-amber-400" />
              ) : (
                <EyeSlash size={16} />
              )}
            </StripCell>
          )}
          {/* A cell with an up/down caret: unstyled text on a row that
					    reads as a table header looks like a column title, not a
					    control. */}
          <Button
            variant="cell"
            size="bar"
            onClick={() => {
              const i = SESSION_SORTS.findIndex((s) => s.id === sort);
              onSort(SESSION_SORTS[(i + 1) % SESSION_SORTS.length].id);
            }}
            title={t(
              "Switch between newest-created, most-recently-active and last-asked",
            )}
          >
            {t(SESSION_SORTS.find((s) => s.id === sort)?.label ?? "")}
            <CaretUpDown size={14} className="text-neutral-500" />
          </Button>
        </div>

        {/* min-h-0 for the same reason as the transcript: a flex item is
				    `min-height: auto` by default, so a long list would push the
				    panel past the viewport and scroll the whole page instead of
				    itself. */}
        <ScrollPane className="min-h-0 flex-1">
          {listError || searchError ? (
            <p className="px-3 py-4 text-meta text-red-400" role="alert">
              {listError ?? searchError}
            </p>
          ) : (
            rows.length === 0 && (
              <p className="px-3 py-4 text-meta text-neutral-400">
                {searching ? t("No sessions match.") : t("No sessions yet.")}
              </p>
            )
          )}
          {rows.slice(0, shown).map((s) => {
            const snippet = searching ? snippets.get(s.path) : undefined;
            const isOpen = openFiles.includes(s.path);
            const label = sessionLabel(s, latestPrompt);
            const attachments =
              (latestPrompt
                ? (s.lastAttachments ?? s.firstAttachments)
                : s.firstAttachments) ?? [];
            const state = attention.get(s.path) ?? null;
            const isHidden = hidden.includes(s.path);

            /*
             * Renaming replaces the row rather than opening a dialog: the
             * thing being named is in front of you, and the new name lands
             * exactly where the old one was.
             *
             * Enter commits. Escape and a click elsewhere BOTH cancel —
             * committing on blur would write a half-typed name from a
             * misclick, and a name is cheap to retype but annoying to undo.
             */
            if (renaming === s.path) {
              return (
                <form
                  key={s.path}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = draft.trim();
                    setRenaming(null);
                    if (next && next !== s.name) onRename(s, next);
                  }}
                  className="border-b border-neutral-800 px-2 py-1.5"
                >
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    onBlur={() => setRenaming(null)}
                    aria-label={t("Rename {name}", { name: label })}
                    className={`w-full ${inputClass.sm}`}
                  />
                  <p className="mt-0.5 text-meta text-neutral-500">
                    {t("Enter to save, Escape to cancel")}
                  </p>
                </form>
              );
            }

            return (
              <button
                data-custom="session card"
                key={s.path}
                onClick={() => onSelect(s)}
                /*
                 * Right-click (and the keyboard's own menu key, which fires
                 * the same event) opens the row menu. No always-visible
                 * affordance: naming is rare next to opening, and a control
                 * per row is forty controls down the panel.
                 */
                onContextMenu={(e) => {
                  e.preventDefault();
                  // A keyboard-raised menu reports (0,0); anchor it to the
                  // row instead so it does not land in the corner.
                  const box = e.currentTarget.getBoundingClientRect();
                  setMenu({
                    path: s.path,
                    x: e.clientX || box.left + 16,
                    y: e.clientY || box.bottom,
                  });
                }}
                aria-current={s.path === activeFile ? "true" : undefined}
                aria-haspopup="menu"
                title={label}
                className={`block w-full border-b border-neutral-800 py-2 pl-3 text-left transition-colors duration-150 ease-out hover:bg-neutral-900 motion-reduce:transition-none ${isHidden ? "opacity-50" : ""}`}
              >
                <div className="session-title text-ui text-neutral-200">
                  {/* The session's state, the same colors as its tab π: amber
									    pulsing while it works, steady green for a new reply, red
									    for a question. Inline, so a wrapped title keeps them on
									    its first line. */}
                  {state && (
                    <span
                      className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${ATTENTION_UI[state].dot}`}
                      title={t(ATTENTION_UI[state].label)}
                    />
                  )}
                  {naming === s.path
                    ? t("Naming…")
                    : highlight(sessionLabel(s, latestPrompt), terms)}
                </div>
                {/*
								  The stamp shown is the one the list is sorted by, so the
								  order is always explained by what each row displays. The
								  tooltip carries both, because "created two days ago, last
								  touched an hour ago" is exactly the question the other
								  sort mode exists to answer.
								*/}
                {showAttachments && attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 pr-3">
                    {attachments.map((attachment, i) =>
                      attachment.kind === "image" ? (
                        <img
                          key={i}
                          src={`/api/sessions/image?${new URLSearchParams({
                            cwd: project,
                            file: s.path,
                            latest: latestPrompt ? "1" : "0",
                            index: String(attachment.index),
                            version: s.lastAsked ?? s.lastActive,
                          })}`}
                          alt={t("Image {n}", { n: attachment.index })}
                          loading="lazy"
                          className="size-14 rounded-md border border-neutral-700 object-cover"
                        />
                      ) : (
                        <span
                          key={i}
                          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border border-neutral-700 px-2 py-1 text-meta text-neutral-400"
                        >
                          <FileText
                            size={14}
                            className="shrink-0 text-amber-400"
                          />
                          <span className="fade-end">{attachment.name}</span>
                        </span>
                      ),
                    )}
                  </div>
                )}
                <div className="mt-0.5 flex items-center gap-3 pr-3">
                  {snippet ? (
                    <div className="min-w-0 flex-1 fade-edge text-meta text-neutral-500">
                      {highlight(snippet, terms)}
                    </div>
                  ) : (
                    <div
                      className="min-w-0 flex-1 flex items-center gap-3 text-meta text-neutral-400"
                      title={t("Created {date}, {ago} · last active {active}", {
                        date: dateFmt().format(new Date(s.created)),
                        ago: timeAgo(s.created),
                        active: timeAgo(s.lastActive),
                      })}
                    >
                      <span className="inline-flex items-center gap-1">
                        <Clock
                          size={12}
                          className="shrink-0 text-neutral-500"
                          aria-hidden
                        />
                        {timeAgo(stamp(s, sort), true)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <ChatCircle
                          size={12}
                          className="shrink-0 text-neutral-500"
                          aria-hidden
                        />
                        {s.messageCount}
                      </span>
                      {pins.includes(s.path) && (
                        <PushPin
                          size={12}
                          weight="fill"
                          className="shrink-0 text-neutral-500"
                          aria-label={t("Pinned")}
                        />
                      )}
                      {isHidden && (
                        <EyeSlash
                          size={12}
                          className="shrink-0 text-neutral-500"
                          aria-label={t("Hidden session")}
                        />
                      )}
                    </div>
                  )}
                  {isOpen && (
                    <span
                      className="shrink-0 text-neutral-500"
                      title={t("Open in a tab")}
                    >
                      <Eye size={14} aria-label={t("Open in a tab")} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {more && <div ref={end} className="h-4" />}
        </ScrollPane>
      </aside>

      {menuSession && menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("Session {name}", {
            name: sessionLabel(menuSession, latestPrompt),
          })}
          onClose={() => setMenu(null)}
        >
          <MenuItem
            role="menuitem"
            autoFocus
            onClick={() => {
              togglePin(menuSession.path);
              setMenu(null);
            }}
          >
            {pins.includes(menuSession.path) ? t("Unpin") : t("Pin to top")}
          </MenuItem>
          <MenuItem
            role="menuitem"
            onClick={() => {
              setDraft(sessionLabel(menuSession, latestPrompt));
              setRenaming(menuSession.path);
              setMenu(null);
            }}
          >
            {t("Rename…")}
          </MenuItem>
          <MenuItem
            role="menuitem"
            onClick={() => {
              toggleHidden(menuSession.path);
              setMenu(null);
            }}
          >
            {hidden.includes(menuSession.path)
              ? t("Unhide")
              : t("Hide from list")}
          </MenuItem>
          {/*
					  The two automatic options, cheapest first. Naming from the
					  first prompt is local and instant; summarising spends a model
					  call and a few seconds on the opening request.
					*/}
          <MenuItem
            role="menuitem"
            disabled={!menuSession.firstMessage?.trim()}
            onClick={() => {
              const next = shortName(menuSession.firstMessage ?? "");
              setMenu(null);
              if (next) onRename(menuSession, next);
            }}
          >
            {t("Name from first prompt")}
          </MenuItem>
          <MenuItem
            role="menuitem"
            onClick={() => {
              setMenu(null);
              setNaming(menuSession.path);
              void onAutoName(menuSession).finally(() => setNaming(null));
            }}
          >
            {t("Summarise with pi")}
            <span className="block text-meta text-neutral-500">
              {t("Asks pi to title the conversation")}
            </span>
          </MenuItem>
        </ContextMenu>
      )}
    </>
  );
}
