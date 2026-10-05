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
import {
  EDITOR_KEYS,
  PALETTE_KEYS,
  SYNTAX_ROLES,
  type ConvertedTheme,
} from "./vscodeTheme.js";
import vscodeThemes from "./vscodeThemes.json";

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Private mode / disabled storage must not break the app.
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export type WorkDisplay = "cursor" | "timeline";
export const WORK_DISPLAYS = [
  {
    id: "cursor",
    label: "Cursor",
    hint: "Quiet thinking and tool disclosures.",
  },
  {
    id: "timeline",
    label: "Timeline",
    hint: "Four timed phases and model rounds.",
  },
] as const;

export function readWorkDisplay(): WorkDisplay {
  return readStored("pwi:workDisplay") === "timeline" ? "timeline" : "cursor";
}

export function writeWorkDisplay(mode: WorkDisplay): void {
  writeStored("pwi:workDisplay", mode);
  window.dispatchEvent(new Event("pwi:workDisplay"));
}

export function subscribeWorkDisplay(onChange: () => void): () => void {
  window.addEventListener("pwi:workDisplay", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener("pwi:workDisplay", onChange);
    window.removeEventListener("storage", onChange);
  };
}

export type CodemodeToolLabels = "text" | "icon" | "both";
export const CODEMODE_TOOL_LABELS = [
  { id: "text", label: "Text" },
  { id: "icon", label: "Icon" },
  { id: "both", label: "Both" },
] as const;

export function readCodemodeToolLabels(): CodemodeToolLabels {
  const value = readStored("pwi:codemodeToolLabels");
  if (value === "text" || value === "icon" || value === "both") return value;
  return readStored("pwi:toolIcons") === "true" ? "both" : "text";
}

export function writeCodemodeToolLabels(mode: CodemodeToolLabels): void {
  writeStored("pwi:codemodeToolLabels", mode);
  window.dispatchEvent(new Event("pwi:codemodeToolLabels"));
}

export function subscribeCodemodeToolLabels(onChange: () => void): () => void {
  window.addEventListener("pwi:codemodeToolLabels", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener("pwi:codemodeToolLabels", onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function readRelativeToolPaths(): boolean {
  return readStored("pwi:relativeToolPaths") !== "false";
}

export function writeRelativeToolPaths(enabled: boolean): void {
  writeStored("pwi:relativeToolPaths", String(enabled));
  window.dispatchEvent(new Event("pwi:relativeToolPaths"));
}

export function subscribeRelativeToolPaths(onChange: () => void): () => void {
  window.addEventListener("pwi:relativeToolPaths", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener("pwi:relativeToolPaths", onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Which palette the UI is painted in: the four Catppuccin flavors, plus
 * Claude's own dark and light interfaces.
 *
 * The palettes themselves live in index.css — this only decides which one is
 * active. Applying a theme is one attribute write on <html>; every color in
 * the app is a Tailwind utility pointed at a variable that attribute selects,
 * so there is nothing to re-render and no component knows a theme exists.
 *
 * Labels are whole names rather than a bare flavor: the list is no longer one
 * family, so the dialog cannot prefix them all with "Catppuccin".
 *
 * After the built-ins come VS Code's themes (vscodeThemes.json, converted by
 * scripts/vscode-themes.ts). Their palettes are not in index.css: applyTheme
 * writes them onto <html> as inline `--ct-*` variables. Their Catppuccin
 * entries are left out, the hand-tuned built-ins already are those.
 */
export const VSCODE_THEMES: Record<string, ConvertedTheme> = vscodeThemes;

const BUILTIN_THEMES = [
  { id: "mocha", label: "Catppuccin Mocha", light: false },
  { id: "macchiato", label: "Catppuccin Macchiato", light: false },
  { id: "frappe", label: "Catppuccin Frappé", light: false },
  { id: "claude", label: "Claude", light: false },
  { id: "latte", label: "Catppuccin Latte", light: true },
  { id: "claude-light", label: "Claude Light", light: true },
];

const vscodeList = (skip: (id: string) => boolean) =>
  Object.entries(VSCODE_THEMES)
    .filter(([id]) => !skip(id))
    .map(([id, th]) => ({ id, label: th.label, light: th.light }))
    .sort((a, b) => a.label.localeCompare(b.label));

/** Dark first, then light; built-ins lead each group. */
const darkThenLight = <T extends { light: boolean }>(list: T[]) => [
  ...list.filter((th) => !th.light),
  ...list.filter((th) => th.light),
];

export const THEMES: { id: string; label: string; light: boolean }[] =
  darkThenLight([
    ...BUILTIN_THEMES,
    ...vscodeList((id) => id.startsWith("catppuccin-")),
  ]);

export type ThemeId = string;

/** Matches the fallback palette on `:root`, and the one index.html assumes. */
export const DEFAULT_THEME: ThemeId = "mocha";

/** The editor follows the app theme unless the user picks one of its own. */
export const MATCH_APP = "app";

/** The VS Code theme whose syntax colors go with an app theme. */
export function syntaxThemeOf(app: ThemeId): string {
  if (VSCODE_THEMES[app]) return app;
  if (app === "claude") return "dark-plus";
  if (app === "claude-light") return "light-plus";
  return `catppuccin-${app}`;
}

/** The theme the editor actually wears. */
export function editorThemeOf(app: ThemeId, editor: string): string {
  return editor === MATCH_APP ? syntaxThemeOf(app) : editor;
}

/** A VS Code theme's `--ct-*` palette, for <html> or a settings swatch. */
export function paletteVars(id: ThemeId): Record<string, string> | undefined {
  const th = VSCODE_THEMES[id];
  return (
    th &&
    Object.fromEntries(PALETTE_KEYS.map((k, i) => [`--ct-${k}`, th.palette[i]]))
  );
}

/** `--<prefix>-<role>` color plus `-fs`/`-fw`/`-td` for the syntax roles codemirror.ts styles. */
function syntaxVars(prefix: string, th: ConvertedTheme): [string, string][] {
  return SYNTAX_ROLES.flatMap((role, i) => {
    const [color, f] = th.syntax[i].split("|");
    const name = `--${prefix}-${role}`;
    const deco = [
      f.includes("u") && "underline",
      f.includes("s") && "line-through",
    ]
      .filter(Boolean)
      .join(" ");
    return [
      color && [name, color],
      f.includes("i") && [`${name}-fs`, "italic"],
      f.includes("b") && [`${name}-fw`, "bold"],
      deco && [`${name}-td`, deco],
    ].filter((v): v is [string, string] => !!v);
  });
}

/**
 * Also hardcoded in the bootstrap script in index.html, which runs before this
 * module is even fetched so the first paint is already in the right flavor.
 */
const THEME_KEY = "pwi:theme";
const EDITOR_THEME_KEY = "pwi:editorTheme";
/** The inline variables and light flag applyTheme last wrote, replayed by index.html before the first paint. */
const THEME_BOOT_KEY = "pwi:themeBoot";

const NOTIFY_KEY = "pwi:notify";
const LATEST_PROMPT_KEY = "pwi:latestPrompt";
const HIDE_SCROLLBARS_KEY = "pwi:hideScrollbars";
const GIT_AUTONAME_KEY = "pwi:gitAutoName";
const GIT_NESTED_KEY = "pwi:gitNested";

export function readTheme(): ThemeId {
  const stored = readStored(THEME_KEY);
  // An unknown palette degrades to the default instead of leaving the app
  // unstyled.
  return THEMES.some((t) => t.id === stored)
    ? (stored as ThemeId)
    : DEFAULT_THEME;
}

export function readEditorTheme(): string {
  const stored = readStored(EDITOR_THEME_KEY);
  return stored && VSCODE_THEMES[stored] ? stored : MATCH_APP;
}

/**
 * Paints the app theme and the editor theme. Built-in palettes come from
 * index.css via `data-theme`; everything else is inline variables on <html>:
 * a VS Code app theme's `--ct-*`, the app's syntax colors `--tk-*` (chat code
 * blocks, diffs), and the editor's `--etk-*` syntax and `--ed-*` chrome.
 */
export function applyTheme(id: ThemeId, editor: string): void {
  const root = document.documentElement;
  const ed =
    VSCODE_THEMES[editorThemeOf(id, editor)] ?? VSCODE_THEMES["dark-plus"];
  const vars: [string, string][] = [
    ...Object.entries(paletteVars(id) ?? {}),
    ...syntaxVars(
      "tk",
      VSCODE_THEMES[syntaxThemeOf(id)] ?? VSCODE_THEMES["dark-plus"],
    ),
    ...syntaxVars("etk", ed),
    ...EDITOR_KEYS.map((k, i): [string, string] => [`--ed-${k}`, ed.editor[i]]),
  ];
  for (const name of [...root.style])
    if (/^--(ct|tk|etk|ed)-/.test(name)) root.style.removeProperty(name);
  for (const [name, value] of vars) root.style.setProperty(name, value);
  const light = THEMES.find((th) => th.id === id)?.light ?? false;
  root.dataset.theme = id;
  root.toggleAttribute("data-light", light);
  writeStored(THEME_KEY, id);
  writeStored(EDITOR_THEME_KEY, editor);
  writeStored(
    THEME_BOOT_KEY,
    JSON.stringify({
      light,
      style: vars.map(([n, v]) => `${n}:${v}`).join(";"),
    }),
  );
}

/**
 * Whether an unnamed session is titled by its latest prompt instead of its
 * first. A name pi holds always wins.
 */
export function readLatestPrompt(): boolean {
  return readStored(LATEST_PROMPT_KEY) !== "0";
}

export function writeLatestPrompt(on: boolean): void {
  writeStored(LATEST_PROMPT_KEY, on ? "1" : "0");
}

/** Hidden scrollbars: panes still scroll by wheel, touch and keyboard. Read before first paint by index.html. */
export function readHideScrollbars(): boolean {
  return readStored(HIDE_SCROLLBARS_KEY) === "1";
}

export function applyHideScrollbars(on: boolean): void {
  if (on) document.documentElement.dataset.scrollbars = "hidden";
  else delete document.documentElement.dataset.scrollbars;
  writeStored(HIDE_SCROLLBARS_KEY, on ? "1" : "0");
}

export function readAlwaysShowScrollbars(): boolean {
  return readStored("pwi:alwaysShowScrollbars") === "1";
}

export const SCROLLBAR_TONES = [
  { id: "700", label: "Current", color: "var(--color-neutral-700)" },
  { id: "800", label: "Surface", color: "var(--color-neutral-800)" },
  { id: "900", label: "Base", color: "var(--color-neutral-900)" },
] as const;
export type ScrollbarTone = (typeof SCROLLBAR_TONES)[number]["id"];

export function readScrollbarTone(): ScrollbarTone {
  const value = readStored("pwi:scrollbarTone");
  return value === "800" || value === "900" ? value : "700";
}

export function applyScrollbarAppearance(
  always: boolean,
  tone: ScrollbarTone,
): void {
  const root = document.documentElement;
  if (root.dataset.scrollbars !== "hidden") {
    if (always) root.dataset.scrollbars = "always";
    else delete root.dataset.scrollbars;
  }
  root.dataset.scrollbarTone = tone;
  writeStored("pwi:alwaysShowScrollbars", always ? "1" : "0");
  writeStored("pwi:scrollbarTone", tone);
}

/**
 * How the transcript fades out above the composer: opacity
 * `floor + (1 - floor)(1 - t^easeIn)^drop` over `length` rem, ending at the box's top
 * edge, which overlaps the transcript by 0.75rem (Chat.tsx `-mt-3`).
 */
export type ChatFade = {
  length: number;
  floor: number;
  easeIn: number;
  drop: number;
};

export const DEFAULT_CHAT_FADE: ChatFade = {
  length: 2.75,
  floor: 0.2,
  easeIn: 1.5,
  drop: 3,
};

/** min, max, step per field. */
export const CHAT_FADE_RANGES: Record<
  keyof ChatFade,
  [number, number, number]
> = {
  length: [0.5, 8, 0.25],
  floor: [0, 1, 0.05],
  easeIn: [1, 4, 0.1],
  drop: [1, 6, 0.1],
};

const CHAT_FADE_KEY = "pwi:chatFade";

export function readChatFade(): ChatFade {
  let stored: Partial<Record<keyof ChatFade, unknown>> = {};
  try {
    stored = JSON.parse(readStored(CHAT_FADE_KEY) ?? "{}") ?? {};
  } catch {
    /* default */
  }
  const fade = { ...DEFAULT_CHAT_FADE };
  for (const key of Object.keys(fade) as (keyof ChatFade)[]) {
    const v = stored[key];
    const [min, max] = CHAT_FADE_RANGES[key];
    if (typeof v === "number" && v >= min && v <= max) fade[key] = v;
  }
  return fade;
}

/** Opacity at `u` (0 = where the fade starts, 1 = the box's top edge). */
export function chatFadeOpacity(fade: ChatFade, u: number): number {
  return fade.floor + (1 - fade.floor) * (1 - u ** fade.easeIn) ** fade.drop;
}

const CHAT_FADE_ON_KEY = "pwi:chatFadeOn";

const MESSAGE_SEPARATORS_KEY = "pwi:messageSeparators";

export function readMessageSeparators(): boolean {
  return readStored(MESSAGE_SEPARATORS_KEY) !== "0";
}

export function applyMessageSeparators(on: boolean): void {
  document.documentElement.dataset.messageSeparators = on ? "on" : "off";
}

export function writeMessageSeparators(on: boolean): void {
  writeStored(MESSAGE_SEPARATORS_KEY, on ? "1" : "0");
  applyMessageSeparators(on);
}

/** On by default; off, the transcript has no mask at all. */
export function readChatFadeOn(): boolean {
  return readStored(CHAT_FADE_ON_KEY) !== "0";
}

export function writeChatFadeOn(on: boolean): void {
  writeStored(CHAT_FADE_ON_KEY, on ? "1" : "0");
  applyChatFade(readChatFade());
}

const SCROLL_PAST_ON_KEY = "pwi:scrollPastOn";
const SCROLL_PAST_KEY = "pwi:scrollPast";

/** min, max, step: how far the transcript scrolls past its last line, in % of the window height. */
export const SCROLL_PAST_RANGE: [number, number, number] = [0, 90, 5];
export const DEFAULT_SCROLL_PAST = 25;

/** On by default, like Cursor. */
export function readScrollPastOn(): boolean {
  return readStored(SCROLL_PAST_ON_KEY) !== "0";
}

export function readScrollPast(): number {
  const v = Number(readStored(SCROLL_PAST_KEY) ?? DEFAULT_SCROLL_PAST);
  const [min, max] = SCROLL_PAST_RANGE;
  return Number.isFinite(v) && v >= min && v <= max ? v : DEFAULT_SCROLL_PAST;
}

/** Stores both and sets `--chat-scroll-past`, the transcript's extra bottom padding (Chat.tsx). */
export function applyScrollPast(on: boolean, amount: number): void {
  writeStored(SCROLL_PAST_ON_KEY, on ? "1" : "0");
  writeStored(SCROLL_PAST_KEY, String(amount));
  document.documentElement.style.setProperty(
    "--chat-scroll-past",
    on ? `${amount}vh` : "0px",
  );
}

const SETTINGS_EXPANDED_KEY = "pwi:settingsExpanded";

/** Whether settings with a details panel (Chat fade) start expanded. On by default. */
export function readSettingsExpanded(): boolean {
  return readStored(SETTINGS_EXPANDED_KEY) !== "0";
}

export function writeSettingsExpanded(on: boolean): void {
  writeStored(SETTINGS_EXPANDED_KEY, on ? "1" : "0");
}

export function applyChatFade(fade: ChatFade): void {
  writeStored(CHAT_FADE_KEY, JSON.stringify(fade));
  if (!readChatFadeOn()) {
    document.documentElement.style.removeProperty("--chat-fade");
    return;
  }
  const stops = ["#000 calc(100% - " + (0.75 + fade.length) + "rem)"];
  for (let i = 1; i <= 24; i++) {
    const u = i / 24;
    const a = chatFadeOpacity(fade, u);
    stops.push(
      `rgb(0 0 0 / ${a.toFixed(3)}) calc(100% - ${(0.75 + (1 - u) * fade.length).toFixed(3)}rem)`,
    );
  }
  document.documentElement.style.setProperty(
    "--chat-fade",
    `linear-gradient(to bottom, ${stops.join(", ")})`,
  );
}

/** How your own long messages show in the transcript. */
export const USER_MODES = [
  {
    id: "clamped",
    label: "Collapsed",
    hint: "Long messages show 3 lines, with Show more.",
  },
  { id: "expanded", label: "Expanded", hint: "Shown in full, with Show less." },
  { id: "full", label: "Always full", hint: "Shown in full, no button." },
] as const;

export type UserMode = (typeof USER_MODES)[number]["id"];

const USER_KEY = "pwi:userMessages";

export function readUserMode(): UserMode {
  const stored = readStored(USER_KEY);
  return USER_MODES.some((m) => m.id === stored)
    ? (stored as UserMode)
    : "clamped";
}

export function writeUserMode(mode: UserMode): void {
  writeStored(USER_KEY, mode);
}

/** Where the row under each message puts its buttons and its time. */
export const FOOTER_LAYOUTS = [
  {
    id: "together",
    label: "Together",
    hint: "Buttons, then the time, on the left.",
  },
  {
    id: "time-right",
    label: "Time on the right",
    hint: "Buttons on the left, the time at the far right.",
  },
  {
    id: "buttons-right",
    label: "Buttons on the right",
    hint: "The time on the left, buttons at the far right.",
  },
] as const;

export type FooterLayout = (typeof FOOTER_LAYOUTS)[number]["id"];

const FOOTER_KEY = "pwi:messageFooter";

export function readFooterLayout(): FooterLayout {
  const stored = readStored(FOOTER_KEY);
  return FOOTER_LAYOUTS.some((m) => m.id === stored)
    ? (stored as FooterLayout)
    : "together";
}

/** A `data-footer` attribute on <html>; index.css moves the time. */
export function applyFooterLayout(layout: FooterLayout): void {
  if (layout === "together") delete document.documentElement.dataset.footer;
  else document.documentElement.dataset.footer = layout;
  writeStored(FOOTER_KEY, layout);
}

/** How many lines a session list title may wrap to. */
export const SESSION_LINES = [
  { id: "1", label: "1" },
  { id: "2", label: "2" },
  { id: "3", label: "3" },
  { id: "all", label: "All" },
] as const;

export type SessionLines = (typeof SESSION_LINES)[number]["id"];

const SESSION_ATTACHMENTS_KEY = "pwi:sessionAttachments";

export function readSessionAttachments(): boolean {
  return readStored(SESSION_ATTACHMENTS_KEY) !== "0";
}

export function writeSessionAttachments(show: boolean): void {
  writeStored(SESSION_ATTACHMENTS_KEY, show ? "1" : "0");
}

const SESSION_LINES_KEY = "pwi:sessionLines";

export function readSessionLines(): SessionLines {
  const stored = readStored(SESSION_LINES_KEY);
  return SESSION_LINES.some((m) => m.id === stored)
    ? (stored as SessionLines)
    : "1";
}

/** A `data-session-lines` attribute on <html>; index.css wraps `.session-title`. */
export function applySessionLines(lines: SessionLines): void {
  if (lines === "1") delete document.documentElement.dataset.sessionLines;
  else document.documentElement.dataset.sessionLines = lines;
  writeStored(SESSION_LINES_KEY, lines);
}

/** Whether the composer's Ask only button stays on after a send. */
export const ASK_MODES = [
  {
    id: "toggle",
    label: "Toggle",
    hint: "Stays on until you switch it off or change session.",
  },
  {
    id: "once",
    label: "One shot",
    hint: "Switches off after you send a question.",
  },
] as const;

export type AskMode = (typeof ASK_MODES)[number]["id"];

const ASK_KEY = "pwi:askMode";

export function readAskMode(): AskMode {
  return readStored(ASK_KEY) === "once" ? "once" : "toggle";
}

export function writeAskMode(mode: AskMode): void {
  writeStored(ASK_KEY, mode);
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

/** Whether Source Control looks one folder down when the project is not a repository. */
export function readGitNested(): boolean {
  return readStored(GIT_NESTED_KEY) === "1";
}

export function writeGitNested(on: boolean): void {
  writeStored(GIT_NESTED_KEY, on ? "1" : "0");
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
  { id: "asked", label: "Last asked" },
] as const;

export type SessionSort = (typeof SESSION_SORTS)[number]["id"];

const SORT_KEY = "pwi:sessionSort";

export function readSessionSort(): SessionSort {
  const stored = readStored(SORT_KEY);
  return SESSION_SORTS.some((s) => s.id === stored)
    ? (stored as SessionSort)
    : "created";
}

export function writeSessionSort(sort: SessionSort): void {
  writeStored(SORT_KEY, sort);
}

const PINNED_SESSIONS_KEY = "pwi:pinnedSessions";

/** Session file paths pinned to the top of the list, in either sort. */
export function readPinnedSessions(): string[] {
  return readPathList(PINNED_SESSIONS_KEY);
}

function readPathList(key: string): string[] {
  const raw = readStored(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

export function writePinnedSessions(paths: string[]): void {
  writeStored(PINNED_SESSIONS_KEY, JSON.stringify(paths));
}

const HIDDEN_SESSIONS_KEY = "pwi:hiddenSessions";

/** Session file paths left out of the session list unless it shows hidden ones. */
export function readHiddenSessions(): string[] {
  return readPathList(HIDDEN_SESSIONS_KEY);
}

export function writeHiddenSessions(paths: string[]): void {
  writeStored(HIDDEN_SESSIONS_KEY, JSON.stringify(paths));
}

const SEEN_SESSIONS_KEY = "pwi:seenSessions";

/**
 * What this browser has already seen of each session: the `lastActive` it had
 * when last on screen. `baseline` stands in for sessions never viewed, and is
 * set the first time this is read, so upgrading does not flag every old
 * session as a new reply.
 */
export interface SeenSessions {
  baseline: string;
  seen: Record<string, string>;
}

export function readSeenSessions(): SeenSessions {
  const raw = readStored(SEEN_SESSIONS_KEY);
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (
      parsed &&
      typeof parsed === "object" &&
      "baseline" in parsed &&
      typeof parsed.baseline === "string"
    ) {
      const seen: Record<string, string> = {};
      const stored =
        "seen" in parsed && parsed.seen && typeof parsed.seen === "object"
          ? parsed.seen
          : {};
      for (const [k, v] of Object.entries(stored))
        if (typeof v === "string") seen[k] = v;
      return { baseline: parsed.baseline, seen };
    }
  } catch {
    /* fall through to a fresh baseline */
  }
  const fresh = { baseline: new Date().toISOString(), seen: {} };
  writeSeenSessions(fresh);
  return fresh;
}

export function writeSeenSessions(value: SeenSessions): void {
  writeStored(SEEN_SESSIONS_KEY, JSON.stringify(value));
}

/**
 * The side panels, which are mutually exclusive: one column, one divider, and
 * the rail switches between them the way an activity bar does. Only what you
 * work beside lives here; pages open as tabs and the terminal is a dock.
 *
 * Lives here rather than in App.tsx because prefs is what persists it, and a
 * type imported the other way round would be a cycle.
 */
export type Panel = "editor" | "review" | null;

const PANELS: readonly string[] = ["editor", "review"];

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

const DOCK_OPEN_KEY = "pwi:dockOpen";

/** Whether the terminal dock is open. Unset: open if the terminal was the side panel. */
export function readDockOpen(): boolean {
  const stored = readStored(DOCK_OPEN_KEY);
  return stored === null
    ? readStored(PANEL_KEY) === "terminal"
    : stored === "1";
}

export function writeDockOpen(open: boolean): void {
  writeStored(DOCK_OPEN_KEY, open ? "1" : "0");
}

const DOCK_HEIGHT_KEY = "pwi:dockHeight";
const DEFAULT_DOCK_PERCENT = 35;

/** The dock's share of the editor area's height, clamped like the panel width. */
export function readDockHeight(): number {
  const raw = readStored(DOCK_HEIGHT_KEY);
  const stored = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(stored)) return DEFAULT_DOCK_PERCENT;
  return Math.min(TERMINAL_MAX_PERCENT, Math.max(TERMINAL_MIN_PERCENT, stored));
}

export function writeDockHeight(percent: number): void {
  writeStored(DOCK_HEIGHT_KEY, String(Math.round(percent)));
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
/** The panel alone may go narrower than the dock: a file tree still reads at a sliver. */
export const PANEL_MIN_PERCENT = 5;

/** Wide enough for 80 columns on a laptop, narrow enough to keep the chat readable. */
const DEFAULT_TERMINAL_PERCENT = 40;

export function readTerminalWidth(): number {
  const raw = readStored(TERM_WIDTH_KEY);
  // Number(null) is 0, not NaN, so an absent value has to be rejected before
  // the parse — otherwise the clamp turns "no preference" into the minimum.
  if (raw === null) return DEFAULT_TERMINAL_PERCENT;
  const stored = Number(raw);
  if (!Number.isFinite(stored)) return DEFAULT_TERMINAL_PERCENT;
  return Math.min(TERMINAL_MAX_PERCENT, Math.max(PANEL_MIN_PERCENT, stored));
}

export function writeTerminalWidth(percent: number): void {
  writeStored(TERM_WIDTH_KEY, String(Math.round(percent)));
}

/**
 * The session list's width, in PIXELS unlike the panel: it is a list of
 * titles, which need the same room at any window size.
 */
const LIST_WIDTH_KEY = "pwi:sessionListWidth";

export const LIST_MIN_PX = 180;
export const LIST_MAX_PX = 640;
const DEFAULT_LIST_PX = 288;

export const clampListWidth = (px: number): number =>
  Math.min(LIST_MAX_PX, Math.max(LIST_MIN_PX, px));

export function readListWidth(): number {
  const raw = readStored(LIST_WIDTH_KEY);
  if (raw === null) return DEFAULT_LIST_PX;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampListWidth(stored) : DEFAULT_LIST_PX;
}

export function writeListWidth(px: number): void {
  writeStored(LIST_WIDTH_KEY, String(Math.round(px)));
}

const TERM_TABS_SIDE_KEY = "pwi:termTabsSide";

/** Which side of the terminal dock its tab list sits on. */
export type TermTabsSide = "left" | "right";

export function readTermTabsSide(): TermTabsSide {
  return readStored(TERM_TABS_SIDE_KEY) === "left" ? "left" : "right";
}

export function writeTermTabsSide(side: TermTabsSide): void {
  writeStored(TERM_TABS_SIDE_KEY, side);
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
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

export function writeExplorerOpen(cwd: string, open: string[]): void {
  writeStored(`pwi:explorer:${cwd}`, JSON.stringify(open));
}
