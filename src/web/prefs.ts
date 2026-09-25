/**
 * The handful of preferences the UI remembers — most of them owned by the
 * settings dialog, one (auto-naming commits) by the git menu.
 *
 * All of them are per-browser UI state, so they live in `localStorage` and
 * never touch the server: nothing here changes how a session runs, only how
 * this page looks at it. Storage is user-writable and outlives any rename, so
 * every read validates and falls back rather than trusting what it finds.
 */

import { EMPTY_LAYOUT, parseLayout, type TermLayout } from "./termLayout.js";

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		// Private mode / disabled storage must not break the app.
		return null;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* ignore */
	}
}

/**
 * Which palette the UI is painted in: the four Catppuccin flavors, plus
 * Claude's own dark interface.
 *
 * The palettes themselves live in index.css — this only decides which one is
 * active. Applying a theme is one attribute write on <html>; every color in
 * the app is a Tailwind utility pointed at a variable that attribute selects,
 * so there is nothing to re-render and no component knows a theme exists.
 *
 * Labels are whole names rather than a bare flavor: the list is no longer one
 * family, so the dialog cannot prefix them all with "Catppuccin".
 */
export const THEMES = [
	{ id: "mocha", label: "Catppuccin Mocha" },
	{ id: "macchiato", label: "Catppuccin Macchiato" },
	{ id: "frappe", label: "Catppuccin Frappé" },
	{ id: "latte", label: "Catppuccin Latte" },
	{ id: "claude", label: "Claude" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** Matches the fallback palette on `:root`, and the one index.html assumes. */
export const DEFAULT_THEME: ThemeId = "mocha";

/**
 * Also hardcoded in the bootstrap script in index.html, which runs before this
 * module is even fetched so the first paint is already in the right flavor.
 */
const THEME_KEY = "pwi:theme";

const THINKING_KEY = "pwi:showThinking";
const TOOL_KEY = "pwi:tools";
const NOTIFY_KEY = "pwi:notify";
const SHORT_NAMES_KEY = "pwi:shortNames";
const GIT_AUTONAME_KEY = "pwi:gitAutoName";

export function readTheme(): ThemeId {
	const stored = readStored(THEME_KEY);
	// An unknown palette degrades to the default instead of leaving the app
	// unstyled.
	return THEMES.some((t) => t.id === stored) ? (stored as ThemeId) : DEFAULT_THEME;
}

export function applyTheme(id: ThemeId): void {
	document.documentElement.dataset.theme = id;
	writeStored(THEME_KEY, id);
}

/**
 * Whether reasoning blocks are rendered in the transcript.
 *
 * On by default: thinking is why the answer looks the way it does, and hiding
 * it by default would make the transcript quietly incomplete. Anything other
 * than an explicit "0" reads as on, so a corrupt value fails visible.
 */
export function readShowThinking(): boolean {
	return readStored(THINKING_KEY) !== "0";
}

export function writeShowThinking(show: boolean): void {
	writeStored(THINKING_KEY, show ? "1" : "0");
}

/**
 * Whether an unnamed session is labelled by a SHORT name derived from its
 * first prompt instead of by the prompt itself.
 *
 * Off by default, because the full first line is strictly more information
 * and the list truncates it anyway. On, the rows read like titles — see
 * sessionName.ts for the derivation. Either way a name pi holds (yours, via
 * rename, or one the naming child produced) wins: this only decides how a
 * session with NO name is described.
 */
export function readShortNames(): boolean {
	return readStored(SHORT_NAMES_KEY) === "1";
}

export function writeShortNames(on: boolean): void {
	writeStored(SHORT_NAMES_KEY, on ? "1" : "0");
}

/**
 * How much of a tool call the transcript shows.
 *
 * `live` is the default and the old behaviour: a call with no result yet is
 * expanded so progress is visible without clicking, and collapses once it
 * settles. It is also the noisiest, which is the reason this setting exists —
 * a long run of edits and reads turns the pane into a wall of arguments while
 * you are waiting for prose.
 *
 * `grouped` goes one step further than collapsing each call: a whole run of
 * consecutive calls becomes ONE line saying what the run did. That is the
 * shape of an agent turn — a dozen reads and edits between two paragraphs of
 * prose — and per-call lines still bury the prose. The count of failed calls
 * stays on the collapsed line, because grouping may hide detail and never
 * that something went wrong.
 *
 * `answer` takes that to its conclusion: a whole turn — every call, every
 * thought, every intermediate "now let me check X" — is ONE line, and only
 * the answer the turn ended on is prose. That is how a chat assistant reads,
 * and for a long agent turn it is the difference between a page of work with
 * an answer somewhere in it and an answer with the work folded behind one
 * line. Still one click from the whole run, and a failure still shows on the
 * folded line.
 */
export const TOOL_MODES = [
	{
		id: "live",
		label: "Expand while running",
		hint: "Collapses once the call finishes.",
	},
	{
		id: "collapsed",
		label: "Always collapsed",
		hint: "One line per call; click to open.",
	},
	{
		id: "grouped",
		label: "Grouped",
		hint: "One line per run of calls; click to list them.",
	},
	{
		id: "answer",
		label: "Answer only",
		hint: "One line per turn; only the final answer stays as prose.",
	},
	{
		id: "hidden",
		label: "Hidden",
		hint: "The status line still names the running tool.",
	},
] as const;

export type ToolMode = (typeof TOOL_MODES)[number]["id"];

export function readToolMode(): ToolMode {
	const stored = readStored(TOOL_KEY);
	return TOOL_MODES.some((m) => m.id === stored) ? (stored as ToolMode) : "live";
}

export function writeToolMode(mode: ToolMode): void {
	writeStored(TOOL_KEY, mode);
}

/**
 * Whether a finished run raises a desktop notification.
 *
 * Off by default, and deliberately not auto-enabled by having permission:
 * notifications are interruptive, and a browser that granted permission for
 * some earlier visit is not consent for this one. Turning it on is what asks
 * the browser, because the click is the user gesture the prompt needs.
 */
export function readNotify(): boolean {
	return readStored(NOTIFY_KEY) === "1";
}

export function writeNotify(on: boolean): void {
	writeStored(NOTIFY_KEY, on ? "1" : "0");
}

/**
 * Whether the commit button names commits itself.
 *
 * Owned by the git menu rather than the settings dialog: it is a property of
 * that button, it is toggled next to the actions it changes, and it is the
 * one preference here you want to flip mid-task rather than once.
 *
 * Off by default. On, the dialog is skipped entirely — `Commit & Push`
 * becomes one click that writes a message with the model and pushes it — and
 * a toggle that did that without being asked for would be the worst default
 * in the app.
 */
export function readGitAutoName(): boolean {
	return readStored(GIT_AUTONAME_KEY) === "1";
}

export function writeGitAutoName(on: boolean): void {
	writeStored(GIT_AUTONAME_KEY, on ? "1" : "0");
}

/**
 * How the session list is ordered.
 *
 * `created` is the default because it is the only order that does not move on
 * its own: a session's creation timestamp is written once, in its header.
 * `active` answers a different and equally real question ("what was I last
 * working on"), and is computed from the last message in the file rather than
 * from the file's mtime — bookkeeping entries, such as the `session_info` a
 * rename appends, move the mtime without the conversation having moved.
 */
export const SESSION_SORTS = [
	{ id: "created", label: "Created" },
	{ id: "active", label: "Last active" },
] as const;

export type SessionSort = (typeof SESSION_SORTS)[number]["id"];

const SORT_KEY = "pwi:sessionSort";

export function readSessionSort(): SessionSort {
	const stored = readStored(SORT_KEY);
	return SESSION_SORTS.some((s) => s.id === stored) ? (stored as SessionSort) : "created";
}

export function writeSessionSort(sort: SessionSort): void {
	writeStored(SORT_KEY, sort);
}

/**
 * The side panels, which are mutually exclusive: one column, one divider, and
 * the rail switches between them the way an activity bar does.
 *
 * Lives here rather than in App.tsx because prefs is what persists it, and a
 * type imported the other way round would be a cycle.
 */
export type Panel = "editor" | "review" | "terminal" | "packages" | null;

const PANELS: readonly string[] = ["editor", "review", "terminal", "packages"];

const PANEL_KEY = "pwi:panel";

/**
 * Which panel the rail last had open, restored on reload.
 *
 * ALL of them, not only the terminal: a closed explorer on every reload is
 * the same annoyance as a closed terminal, and the rail cannot tell you which
 * one you were using if it only remembers one of them.
 */
export function readPanel(): Panel {
	const stored = readStored(PANEL_KEY);
	return stored !== null && PANELS.includes(stored) ? (stored as Panel) : null;
}

export function writePanel(panel: Panel): void {
	writeStored(PANEL_KEY, panel ?? "");
}

/**
 * How wide the panel column is.
 *
 * One width for every panel, because there is only ever one panel column —
 * the editor, changes, terminal and packages all live in it and only one at a
 * time. The key keeps its `terminal` name so an existing preference is not
 * silently reset to the default by a rename.
 *
 * Width is a PERCENTAGE of the panel+chat track, not pixels: the same
 * browser gets used at 1280 and at 2560, and a pixel width restored into the
 * narrower one leaves the chat as a column too thin to read. Clamped on read
 * because a stored value can be anything, and a 2% pane is a pane you cannot
 * grab back.
 */
const TERM_WIDTH_KEY = "pwi:terminalWidth";

export const TERMINAL_MIN_PERCENT = 15;
export const TERMINAL_MAX_PERCENT = 85;

/** Wide enough for 80 columns on a laptop, narrow enough to keep the chat readable. */
const DEFAULT_TERMINAL_PERCENT = 40;

export function readTerminalWidth(): number {
	const raw = readStored(TERM_WIDTH_KEY);
	// Number(null) is 0, not NaN, so an absent value has to be rejected before
	// the parse — otherwise the clamp turns "no preference" into the minimum.
	if (raw === null) return DEFAULT_TERMINAL_PERCENT;
	const stored = Number(raw);
	if (!Number.isFinite(stored)) return DEFAULT_TERMINAL_PERCENT;
	return Math.min(TERMINAL_MAX_PERCENT, Math.max(TERMINAL_MIN_PERCENT, stored));
}

export function writeTerminalWidth(percent: number): void {
	writeStored(TERM_WIDTH_KEY, String(Math.round(percent)));
}


/**
 * Where each project's terminals are drawn: its tabs, splits and their
 * shares. Per project and not global, because the shells are — a layout
 * restored onto another project's cwd would name terminals it has none of.
 *
 * The shells themselves are the server's, and this is only the arrangement:
 * see termLayout.ts, whose `reconcile` is what makes a restored arrangement
 * agree with the shells that still exist.
 */
export function readTerminalLayout(cwd: string): TermLayout {
	const raw = readStored(`pwi:termLayout:${cwd}`);
	if (!raw) return EMPTY_LAYOUT;
	// Parsed AND validated here, so a caller cannot forget the second half:
	// stored JSON is user-writable, and `parseLayout` is what turns whatever
	// is on disk into a layout that is safe to render.
	try {
		return parseLayout(JSON.parse(raw));
	} catch {
		return EMPTY_LAYOUT;
	}
}

export function writeTerminalLayout(cwd: string, layout: TermLayout): void {
	writeStored(`pwi:termLayout:${cwd}`, JSON.stringify(layout));
}

/**
 * Which explorer directories are expanded, as absolute paths.
 *
 * Per project for the same reason the terminal layout is: the paths are that
 * project's, and restoring them onto another cwd would expand nothing.
 *
 * A SET of open paths rather than a nested shape mirroring the tree, because
 * the tree is fetched a directory at a time and its shape is not known until
 * it arrives — a flat set is answerable the moment a node renders, at any
 * depth, without waiting for its parent's listing.
 *
 * Unbounded on purpose: it is one string per directory you expanded, and a
 * cap would silently forget the deepest one, which is the one you were
 * working in.
 */
export function readExplorerOpen(cwd: string): string[] {
	const raw = readStored(`pwi:explorer:${cwd}`);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		// Storage is user-writable, so this validates rather than casts.
		return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}

export function writeExplorerOpen(cwd: string, open: string[]): void {
	writeStored(`pwi:explorer:${cwd}`, JSON.stringify(open));
}
