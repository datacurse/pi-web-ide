import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ArrowCounterClockwise,
  Bell,
  ChatText,
  GearSix,
  Keyboard,
  ListBullets,
  Palette,
  PencilSimple,
  X,
} from "@phosphor-icons/react";
import {
  Button,
  IconButton,
  inputClass,
  NavItem,
  OptionRow,
  PanelHeader,
  Section,
} from "./ui.js";
import {
  comboOf,
  formatCombo,
  isReserved,
  readBindings,
  recorder,
  SHORTCUTS,
  writeBinding,
  type ShortcutId,
} from "./shortcuts.js";
import {
  applyChatFade,
  SCROLLBAR_TONES,
  type ScrollbarTone,
  readMessageSeparators,
  readWorkDisplay,
  readCodemodeCollapsed,
  writeCodemodeCollapsed,
  readCodemodeToolLabels,
  CODEMODE_TOOL_LABELS,
  readRelativeToolPaths,
  writeRelativeToolPaths,
  writeCodemodeToolLabels,
  writeWorkDisplay,
  WORK_DISPLAYS,
  writeMessageSeparators,
  applyFooterLayout,
  applyScrollPast,
  applySessionLines,
  readSessionLines,
  SESSION_LINES,
  SESSION_SORTS,
  type SessionSort,
  chatFadeOpacity,
  CHAT_FADE_RANGES,
  DEFAULT_CHAT_FADE,
  readChatFade,
  readChatFadeOn,
  readFooterLayout,
  readScrollPast,
  readScrollPastOn,
  readSettingsExpanded,
  SCROLL_PAST_RANGE,
  writeChatFadeOn,
  writeSettingsExpanded,
  type ChatFade,
  editorThemeOf,
  MATCH_APP,
  paletteVars,
  THEMES,
  VSCODE_THEMES,
  USER_MODES,
  FOOTER_LAYOUTS,
  ASK_MODES,
  type AskMode,
  type ThemeId,
  type UserMode,
} from "./prefs.js";
import { t } from "./i18n.js";
import { SYNTAX_ROLES } from "./vscodeTheme.js";
import { AutomaticActions } from "./AutomaticActions.js";
import { AgentInstructions } from "./AgentInstructions.js";
import { CodemodeSettings } from "./CodemodeSettings.js";

const CATEGORIES = [
  { id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
  { id: "transcript", label: "Chat", icon: <ChatText size={16} /> },
  { id: "sessions", label: "Sessions", icon: <ListBullets size={16} /> },
  {
    id: "instructions",
    label: "Agent instructions",
    icon: <ListBullets size={16} />,
  },
  { id: "automatic", label: "Automation", icon: <GearSix size={16} /> },
  { id: "tools", label: "Tools", icon: <GearSix size={16} /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
  {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: <Keyboard size={16} />,
  },
  { id: "general", label: "General", icon: <GearSix size={16} /> },
] as const;
type Category = (typeof CATEGORIES)[number]["id"];

const CATEGORY_HINTS: Record<Category, string> = {
  appearance:
    "Themes and scrollbars. Saved in this browser; changes apply immediately.",
  transcript:
    "How conversations look and how the message box behaves. Saved in this browser.",
  sessions: "How sessions appear in the sidebar. Saved in this browser.",
  instructions:
    "Instructions loaded by the agent from global and project AGENTS.md files.",
  automatic:
    "Background models and context management. Saved on this machine, independently of the chat model.",
  tools:
    "Which tools the agent can use. These settings change agent behavior, not the chat display.",
  notifications:
    "Desktop alerts for this browser. Your browser must allow notifications for this site.",
  shortcuts:
    "App-wide key bindings saved in this browser. Select the pencil to record a shortcut; Escape cancels.",
  general: "Preferences for the settings page. Saved in this browser.",
};

/**
 * Four squares of a palette's actual colors: backdrop, border, body text,
 * accent.
 *
 * The colors come from the SAME `data-theme` mechanism that paints the app,
 * so a preview cannot drift from what selecting it will look like, and no hex
 * value is duplicated outside index.css. The frame is deliberately outside
 * the themed subtree so it stays in the palette currently in use.
 */
function Swatch({ theme }: { theme: ThemeId }) {
  return (
    <span
      aria-hidden
      className="flex shrink-0 overflow-hidden rounded-sm border border-neutral-700"
    >
      {/* A VS Code theme's palette is not in index.css, so it comes along inline. */}
      <span
        data-theme={theme}
        style={paletteVars(theme) as CSSProperties}
        className="flex"
      >
        <span className="block size-4 bg-neutral-950" />
        <span className="block size-4 bg-neutral-800" />
        <span className="block size-4 bg-neutral-100" />
        <span className="block size-4 bg-amber-400" />
      </span>
    </span>
  );
}

/** An editor theme's background, then its keyword, string and function colors. */
function EditorSwatch({ theme }: { theme: string }) {
  const th = VSCODE_THEMES[theme];
  const [kw, str, fn] = (["keyword", "string", "function"] as const).map(
    (role) =>
      th.syntax[SYNTAX_ROLES.indexOf(role)].split("|")[0] || th.editor[1],
  );
  return (
    <span
      aria-hidden
      className="flex shrink-0 overflow-hidden rounded-sm border border-neutral-700"
    >
      {[th.editor[0], kw, str, fn].map((c, i) => (
        <span key={i} className="block size-4" style={{ background: c }} />
      ))}
    </span>
  );
}

const CHAT_FADE_FIELDS: { key: keyof ChatFade; label: string; hint: string }[] =
  [
    {
      key: "length",
      label: "Fade distance",
      hint: "Distance above the message box, in rem (relative to font size).",
    },
    {
      key: "floor",
      label: "Minimum opacity",
      hint: "Visibility at the message box: 0 hides text; 1 keeps it fully visible.",
    },
    {
      key: "easeIn",
      label: "Start softness",
      hint: "Higher values make the fade begin more gradually; 1 starts abruptly.",
    },
    {
      key: "drop",
      label: "Fade strength",
      hint: "Higher values dim text earlier in the fade.",
    },
  ];

/** Sliders for the transcript's fade above the composer, applied live. */
function ChatFadeControl({ expandByDefault }: { expandByDefault: boolean }) {
  const [fade, setFade] = useState(readChatFade);
  const [on, setOn] = useState(readChatFadeOn);
  const [open, setOpen] = useState(expandByDefault);
  // Flipping the default shows its effect right away.
  useEffect(() => setOpen(expandByDefault), [expandByDefault]);
  const change = (next: ChatFade) => {
    setFade(next);
    applyChatFade(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <OptionRow className="flex-1">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => {
              setOn(e.target.checked);
              writeChatFadeOn(e.target.checked);
            }}
            className="size-4 shrink-0 accent-amber-400"
          />
          <span className="flex-1">
            {t("Fade above the message box")}
            <span className="block text-meta text-neutral-500">
              {t("Gradually fade messages where they meet the message box.")}
            </span>
          </span>
        </OptionRow>
        {on && open && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => change(DEFAULT_CHAT_FADE)}
          >
            {t("Reset")}
          </Button>
        )}
        {on && (
          // A fixed target that cannot shrink beside the setting's description.
          <button
            type="button"
            data-custom="settings gear"
            aria-label={open ? t("Collapse") : t("Expand")}
            title={open ? t("Collapse") : t("Expand")}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className={`flex size-12 shrink-0 items-center justify-center self-center rounded-sm transition-colors duration-150 ease-out motion-reduce:transition-none ${
              open
                ? "bg-neutral-800 text-neutral-100"
                : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
            }`}
          >
            <GearSix size={24} />
          </button>
        )}
      </div>
      {on && open && (
        <div className="flex flex-col gap-2 px-2">
          {/* One grid for all fields: names share a column, so every description starts at the same edge. */}
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
            {CHAT_FADE_FIELDS.map((f) => (
              <FadeField
                key={f.key}
                label={t(f.label)}
                hint={t(f.hint)}
                range={CHAT_FADE_RANGES[f.key]}
                value={fade[f.key]}
                onChange={(v) => change({ ...fade, [f.key]: v })}
              />
            ))}
          </div>
          <ChatFadePreview fade={fade} />
        </div>
      )}
    </div>
  );
}

/** Toggle for scrolling the transcript past its last line, with the amount while on. */
function ScrollPastControl() {
  const [on, setOn] = useState(readScrollPastOn);
  const [amount, setAmount] = useState(readScrollPast);
  const change = (nextOn: boolean, next: number) => {
    setOn(nextOn);
    setAmount(next);
    applyScrollPast(nextOn, next);
  };
  return (
    <div className="flex flex-col gap-2">
      <OptionRow>
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => change(e.target.checked, amount)}
          className="size-4 shrink-0 accent-amber-400"
        />
        <span className="flex-1">
          {t("Scroll past the end")}
          <span className="block text-meta text-neutral-500">
            {t(
              "Add space below the last message so you can scroll it above the message box.",
            )}
          </span>
        </span>
      </OptionRow>
      {on && (
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 px-2">
          <FadeField
            label={t("Extra space")}
            hint={t(
              "Space below the last message, as a percentage of the window height.",
            )}
            range={SCROLL_PAST_RANGE}
            value={amount}
            onChange={(v) => change(true, v)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Name with its description beside it; under them a typeable number and a slider.
 * The box keeps what you type until it leaves focus and applies it whenever it is
 * a number in range, so a half-typed "0." is not snapped back.
 */
function FadeField({
  label,
  hint,
  range: [min, max, step],
  value,
  onChange,
}: {
  label: string;
  hint: string;
  range: [number, number, number];
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="contents">
      <label htmlFor={id} className="pt-2">
        {label}
      </label>
      <span className="pt-2 text-meta text-neutral-500">{hint}</span>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step="any"
        value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = e.target.valueAsNumber;
          if (v >= min && v <= max) onChange(v);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={`w-16 font-mono ${inputClass.sm}`}
      />
      <input
        data-custom="range slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => {
          setDraft(null);
          onChange(Number(e.target.value));
        }}
        style={
          {
            "--fill": `${((value - min) / (max - min)) * 100}%`,
          } as CSSProperties
        }
        className="range w-full"
      />
    </div>
  );
}

/**
 * The curve beside a sample answer masked by the live `--chat-fade`, over a mock
 * message box. Both columns are `height` rem tall, so the chart's rows line up
 * with the text: x is opacity, y is the same vertical position as the text.
 */
function ChatFadePreview({ fade }: { fade: ChatFade }) {
  const height = fade.length + 3;
  const start = height - 0.75 - fade.length;
  const box = height - 0.75;
  const points = [`1,0`, `1,${start}`];
  for (let i = 1; i <= 48; i++) {
    const u = i / 48;
    points.push(`${chatFadeOpacity(fade, u)},${start + u * fade.length}`);
  }
  points.push(`${fade.floor},${height}`);
  return (
    <div className="mt-2 grid grid-cols-2 gap-3">
      <div>
        <svg
          viewBox={`0 0 1 ${height}`}
          preserveAspectRatio="none"
          style={{ height: `${height}rem` }}
          className="block w-full rounded-sm bg-neutral-900"
          aria-hidden
        >
          {[0.25, 0.5, 0.75].map((x) => (
            <line
              key={x}
              x1={x}
              x2={x}
              y1={0}
              y2={height}
              className="stroke-neutral-800"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {[start, box].map((y) => (
            <line
              key={y}
              x1={0}
              x2={1}
              y1={y}
              y2={y}
              className="stroke-neutral-600"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <polygon
            points={`0,0 ${points.join(" ")} 0,${height}`}
            className="fill-amber-500/15"
          />
          <polyline
            points={points.join(" ")}
            fill="none"
            className="stroke-amber-400"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="mt-1 flex justify-between text-caption text-neutral-500">
          <span>0</span>
          <span>{t("opacity")}</span>
          <span>1</span>
        </div>
      </div>
      <div>
        <div
          style={{ height: `${height}rem` }}
          className="fade-bottom flex flex-col justify-end overflow-hidden"
        >
          {/* The box (overlapping 0.75rem) cuts through the middle of the last line's lowercase:
					    the paragraph's bottom is trimmed to the baseline, then half an x-height below the box. */}
          <p className="mb-[calc(0.75rem_-_0.5ex)] text-body text-neutral-200 [text-box:trim-end_ex_alphabetic]">
            {t(
              "The tests pass and the build is clean. I renamed the helper, moved the parser into its own module and updated every caller, so nothing else should need to change. The old export stays as an alias for one release.",
            )}
          </p>
        </div>
        <div className="relative -mt-3 rounded-lg bg-neutral-900 px-3 py-2 text-body text-neutral-600 ring-1 ring-neutral-800 ring-inset">
          {t("Message pi…")}
        </div>
      </div>
    </div>
  );
}

/**
 * The Settings page, shown in the page dialog: one <fieldset> per setting, all
 * grouped by purpose. Display preferences are browser-local; agent settings
 * are saved on the server. Extension settings live in Packages.
 */
export function Settings({
  cwd,
  open,
  theme,
  editorTheme,
  onEditorTheme,
  onBrowseThemes,
  userMode,
  onUserMode,
  askMode,
  onAskMode,
  notify,
  onNotify,
  latestPrompt,
  onLatestPrompt,
  sessionAttachments,
  onSessionAttachments,
  sessionSort,
  onSessionSort,
  hideScrollbars,
  onHideScrollbars,
  alwaysShowScrollbars,
  onAlwaysShowScrollbars,
  scrollbarTone,
  onScrollbarTone,
  onClose,
}: {
  cwd?: string;
  open: boolean;
  theme: ThemeId;
  editorTheme: string;
  onEditorTheme: (theme: string) => void;
  onBrowseThemes: () => void;
  userMode: UserMode;
  onUserMode: (mode: UserMode) => void;
  askMode: AskMode;
  onAskMode: (mode: AskMode) => void;
  notify: boolean;
  onNotify: (on: boolean) => Promise<void>;
  latestPrompt: boolean;
  onLatestPrompt: (on: boolean) => void;
  sessionAttachments: boolean;
  onSessionAttachments: (on: boolean) => void;
  sessionSort: SessionSort;
  onSessionSort: (sort: SessionSort) => void;
  hideScrollbars: boolean;
  onHideScrollbars: (on: boolean) => void;
  alwaysShowScrollbars: boolean;
  onAlwaysShowScrollbars: (on: boolean) => void;
  scrollbarTone: ScrollbarTone;
  onScrollbarTone: (value: ScrollbarTone) => void;
  onClose: () => void;
}) {
  const supported =
    typeof Notification !== "undefined" && window.isSecureContext;
  const readPermission = () => (supported ? Notification.permission : "denied");
  const [permission, setPermission] = useState(readPermission);
  const [notificationStatus, setNotificationStatus] = useState("");
  const [notificationPending, setNotificationPending] = useState(false);
  useEffect(() => {
    if (!open) return;
    const refresh = () => setPermission(readPermission());
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, supported]);
  const notifyBlocked = !supported || permission === "denied";
  const notifyHint = !supported
    ? t("Notifications require HTTPS or localhost and a supported browser.")
    : permission === "denied"
      ? t("Blocked — allow notifications for this site in your browser.")
      : permission === "default"
        ? t("Enable to allow desktop notifications in your browser.")
        : t(
            "Send a desktop notification when the agent finishes while this page is in the background. Includes the first line of the answer.",
          );
  const changeNotifications = async (on: boolean) => {
    setNotificationPending(true);
    setNotificationStatus("");
    try {
      await onNotify(on);
    } catch (error) {
      setNotificationStatus(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setPermission(readPermission());
      setNotificationPending(false);
    }
  };
  const testNotification = () => {
    try {
      const notification = new Notification("pwi", {
        body: t("Desktop notifications are working."),
        tag: "pwi:test",
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      notification.onerror = () =>
        setNotificationStatus(
          t("The browser could not display the notification."),
        );
      setNotificationStatus(
        t(
          "Test notification sent. If it does not appear, check your system notification settings and Do Not Disturb.",
        ),
      );
    } catch (error) {
      setNotificationStatus(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const [category, setCategory] = useState<Category>("appearance");
  const [expandDetails, setExpandDetails] = useState(readSettingsExpanded);
  const [footer, setFooter] = useState(readFooterLayout);
  const [workDisplay, setWorkDisplay] = useState(readWorkDisplay);
  const [codemodeCollapsed, setCodemodeCollapsed] = useState(
    readCodemodeCollapsed,
  );
  const [codemodeToolLabels, setCodemodeToolLabels] = useState(
    readCodemodeToolLabels,
  );
  const [relativeToolPaths, setRelativeToolPaths] = useState(
    readRelativeToolPaths,
  );
  const [messageSeparators, setMessageSeparators] = useState(
    readMessageSeparators,
  );
  const [sessionLines, setSessionLines] = useState(readSessionLines);
  const [bindings, setBindings] = useState(readBindings);
  /** The shortcut whose new keys are being recorded. */
  const [recording, setRecording] = useState<ShortcutId | null>(null);

  /*
   * Record the next key press as the binding. Captured on window ahead of
   * everything but App's dispatcher, which stands down while `recorder` is
   * active. A key needs Ctrl, Alt or Meta, so a binding never eats typing;
   * Escape or a click anywhere cancels (the page stays mounted when closed,
   * and a recorder left running would swallow every key).
   */
  useEffect(() => {
    if (!recording) return;
    recorder.active = true;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const digits = recording === "tab.select";
      const combo = comboOf(e, digits);
      if (e.key === "Escape" && combo === "Escape") return setRecording(null);
      if (!combo || !(e.ctrlKey || e.altKey || e.metaKey)) return;
      if (digits && !combo.endsWith("+Digit")) return;
      setBindings(writeBinding(recording, combo));
      setRecording(null);
    };
    const cancel = () => setRecording(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", cancel, true);
    return () => {
      recorder.active = false;
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", cancel, true);
    };
  }, [recording]);
  const [query, setQuery] = useState("");
  const results = useRef<HTMLDivElement>(null);

  /*
   * Every setting as one searchable item: `label` is its name (fuzzy-matched),
   * `text` everything else a search should find it by. Items render in
   * category order, so a search result reads like the pages it came from.
   */
  const items: {
    category: Category;
    group?: string;
    label: string;
    text: string;
    node: ReactNode;
  }[] = [
    {
      category: "appearance",
      group: t("Themes"),
      label: t("Theme"),
      text: `color colour palette dark light vs code browse ${THEMES.map((th) => th.label).join(" ")}`,
      node: (
        <div className="flex items-center gap-3 px-2 py-2 text-ui">
          <Swatch theme={theme} />
          <span className="flex-1">
            {t("Theme")}
            <span className="block text-meta text-neutral-500">
              {THEMES.find((th) => th.id === theme)?.label}
            </span>
          </span>
          <Button size="sm" variant="subtle" onClick={onBrowseThemes}>
            {t("Browse themes")}
          </Button>
        </div>
      ),
    },
    {
      category: "appearance",
      group: t("Themes"),
      label: t("Editor theme"),
      text: "code editor syntax color colour highlighting vs code match",
      node: (
        <div className="flex items-center gap-3 px-2 py-2 text-ui">
          <EditorSwatch theme={editorThemeOf(theme, editorTheme)} />
          <span className="flex-1">
            {t("Editor theme")}
            <span className="block text-meta text-neutral-500">
              {editorTheme === MATCH_APP
                ? t("Match app theme")
                : VSCODE_THEMES[editorTheme].label}
            </span>
          </span>
          {editorTheme !== MATCH_APP && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onEditorTheme(MATCH_APP)}
            >
              {t("Match app theme")}
            </Button>
          )}
        </div>
      ),
    },
    {
      category: "appearance",
      group: t("Scrollbars"),
      label: t("Scrollbar visibility"),
      text: "scroll bar sidebar auto hide always visible hidden wheel touch keyboard",
      node: (
        <div role="radiogroup" aria-label={t("Scrollbar visibility")}>
          {[
            {
              id: "auto",
              label: "Auto-hide",
              hint: "Show while scrolling, then fade away.",
            },
            {
              id: "always",
              label: "Always visible",
              hint: "Keep scrollbars visible whenever a pane can scroll.",
            },
            {
              id: "hidden",
              label: "Hidden",
              hint: "Panes still scroll with the wheel, touch and keyboard.",
            },
          ].map((mode) => {
            const selected =
              (hideScrollbars
                ? "hidden"
                : alwaysShowScrollbars
                  ? "always"
                  : "auto") === mode.id;
            return (
              <OptionRow key={mode.id} selected={selected}>
                <input
                  type="radio"
                  name="scrollbarVisibility"
                  checked={selected}
                  onChange={() => {
                    onHideScrollbars(mode.id === "hidden");
                    onAlwaysShowScrollbars(mode.id === "always");
                  }}
                  className="size-3.5 shrink-0 accent-amber-400"
                />
                <span className="flex-1">
                  {t(mode.label)}
                  <span className="block text-meta text-neutral-500">
                    {t(mode.hint)}
                  </span>
                </span>
              </OptionRow>
            );
          })}
        </div>
      ),
    },
    {
      category: "appearance",
      group: t("Scrollbars"),
      label: t("Scrollbar tone"),
      text: "scroll bar sidebar tone dark color colour",
      node: (
        <div role="radiogroup" aria-label={t("Scrollbar tone")}>
          <div className="px-2 py-1 text-ui">{t("Scrollbar tone")}</div>
          <div className="px-2 pb-1 text-meta text-neutral-500">
            {t("Pick a tone from the active theme.")}
          </div>
          {SCROLLBAR_TONES.map((tone) => (
            <OptionRow key={tone.id} selected={scrollbarTone === tone.id}>
              <input
                type="radio"
                name="scrollbarTone"
                checked={scrollbarTone === tone.id}
                disabled={hideScrollbars}
                onChange={() => onScrollbarTone(tone.id)}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span
                aria-hidden
                className="size-4 shrink-0 rounded-sm border border-neutral-600"
                style={{ background: tone.color }}
              />
              <span>{t(tone.label)}</span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "transcript",
      group: t("Messages"),
      label: t("Long user messages"),
      text: `prompt collapse expand show more ${USER_MODES.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
      node: (
        <div role="radiogroup" aria-labelledby="user-mode-label">
          <div
            id="user-mode-label"
            className="px-2 pt-1 pb-1 text-ui text-neutral-300"
          >
            {t("Long user messages")}
          </div>
          {USER_MODES.map((m) => (
            <OptionRow key={m.id} selected={m.id === userMode}>
              <input
                type="radio"
                name="userMode"
                value={m.id}
                checked={m.id === userMode}
                onChange={() => onUserMode(m.id)}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span className="flex-1">
                {t(m.label)}
                <span className="block text-meta text-neutral-500">
                  {t(m.hint)}
                </span>
              </span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "transcript",
      group: t("Messages"),
      label: t("Message separators"),
      text: `divider line turn ${t("Show lines between conversation turns.")}`,
      node: (
        <OptionRow>
          <input
            type="checkbox"
            checked={messageSeparators}
            onChange={(e) => {
              setMessageSeparators(e.target.checked);
              writeMessageSeparators(e.target.checked);
            }}
            className="size-4 shrink-0 accent-amber-400"
          />
          <span className="flex-1">
            {t("Message separators")}
            <span className="block text-meta text-neutral-500">
              {t("Show lines between conversation turns.")}
            </span>
          </span>
        </OptionRow>
      ),
    },
    {
      category: "transcript",
      group: t("Messages"),
      label: t("Message action layout"),
      text: `copy edit fork time buttons right left align ${FOOTER_LAYOUTS.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
      node: (
        <div role="radiogroup" aria-labelledby="footer-layout-label">
          <div
            id="footer-layout-label"
            className="px-2 pt-1 pb-1 text-ui text-neutral-300"
          >
            {t("Message action layout")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Position the copy, edit, and fork buttons and the timestamp below messages.",
              )}
            </span>
          </div>
          {FOOTER_LAYOUTS.map((m) => (
            <OptionRow key={m.id} selected={m.id === footer}>
              <input
                type="radio"
                name="footerLayout"
                value={m.id}
                checked={m.id === footer}
                onChange={() => {
                  setFooter(m.id);
                  applyFooterLayout(m.id);
                }}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span className="flex-1">
                {t(m.label)}
                <span className="block text-meta text-neutral-500">
                  {t(m.hint)}
                </span>
              </span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "transcript",
      group: t("Agent activity"),
      label: t("Agent activity"),
      text: "cursor timeline working visualization phases timing rounds",
      node: (
        <div role="radiogroup" aria-label={t("Agent activity")}>
          <div className="px-2 py-1 text-ui">{t("Agent activity")}</div>
          <p className="px-2 pb-1 text-meta text-neutral-500">
            {t(
              "Choose how thinking, tool calls, and elapsed time appear in the conversation.",
            )}
          </p>
          {WORK_DISPLAYS.map((mode) => (
            <OptionRow key={mode.id} selected={workDisplay === mode.id}>
              <input
                type="radio"
                name="workDisplay"
                checked={workDisplay === mode.id}
                onChange={() => {
                  setWorkDisplay(mode.id);
                  writeWorkDisplay(mode.id);
                }}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span className="flex-1">
                {t(mode.label)}
                <span className="block text-meta text-neutral-500">
                  {t(mode.hint)}
                </span>
              </span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "transcript",
      group: t("Agent activity"),
      label: t("Collapse codemode"),
      text: "codemode collapsed expanded nested tools hide disclosure",
      node: (
        <OptionRow>
          <input
            type="checkbox"
            checked={codemodeCollapsed}
            onChange={(e) => {
              setCodemodeCollapsed(e.target.checked);
              writeCodemodeCollapsed(e.target.checked);
            }}
            className="size-4 shrink-0 accent-amber-400"
          />
          <span className="flex-1">
            {t("Collapse codemode")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Start codemode groups collapsed. Click a group to show its nested tool calls.",
              )}
            </span>
          </span>
        </OptionRow>
      ),
    },
    {
      category: "transcript",
      group: t("Agent activity"),
      label: t("Nested tool labels"),
      text: "codemode nested tools modules names labels text icon both read search replace diagnostics command",
      node: (
        <OptionRow>
          <span className="flex-1">
            {t("Nested tool labels")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Show names, icons, or both for tools called inside codemode. The parent codemode label always uses text.",
              )}
            </span>
          </span>
          <select
            aria-label={t("Nested tool labels")}
            value={codemodeToolLabels}
            onChange={(e) => {
              const mode = CODEMODE_TOOL_LABELS.find(
                (option) => option.id === e.target.value,
              )?.id;
              if (!mode) return;
              setCodemodeToolLabels(mode);
              writeCodemodeToolLabels(mode);
            }}
            className={inputClass.sm}
          >
            {CODEMODE_TOOL_LABELS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </OptionRow>
      ),
    },
    {
      category: "transcript",
      group: t("Agent activity"),
      label: t("Shorten project file paths"),
      text: "tools paths project relative absolute full directory",
      node: (
        <OptionRow>
          <input
            type="checkbox"
            checked={relativeToolPaths}
            onChange={(e) => {
              setRelativeToolPaths(e.target.checked);
              writeRelativeToolPaths(e.target.checked);
            }}
            className="size-4 shrink-0 accent-amber-400"
          />
          <span className="flex-1">
            {t("Shorten project file paths")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Show paths relative to the project, such as src/app.ts, instead of full paths. Files outside the project keep their full paths.",
              )}
            </span>
          </span>
        </OptionRow>
      ),
    },
    {
      category: "transcript",
      group: t("Scrolling"),
      label: t("Scroll past the end"),
      text: `overscroll bottom padding ${t("Add space below the last message so you can scroll it above the message box.")} ${t("Extra space")}`,
      node: <ScrollPastControl />,
    },
    {
      category: "transcript",
      group: t("Scrolling"),
      label: t("Fade above the message box"),
      text: `gradient mask composer message box ${CHAT_FADE_FIELDS.map((f) => `${t(f.label)} ${t(f.hint)}`).join(" ")}`,
      node: <ChatFadeControl expandByDefault={expandDetails} />,
    },
    {
      category: "transcript",
      group: t("Message box"),
      label: t("Ask only behavior"),
      text: `question once sticky ${ASK_MODES.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
      node: (
        <div role="radiogroup" aria-labelledby="ask-mode-label">
          <div
            id="ask-mode-label"
            className="px-2 pt-1 pb-1 text-ui text-neutral-300"
          >
            {t("Ask only behavior")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Choose when the message box’s ? button switches off after you enable it.",
              )}
            </span>
          </div>
          {ASK_MODES.map((m) => (
            <OptionRow key={m.id} selected={m.id === askMode}>
              <input
                type="radio"
                name="askMode"
                value={m.id}
                checked={m.id === askMode}
                onChange={() => onAskMode(m.id)}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span className="flex-1">
                {t(m.label)}
                <span className="block text-meta text-neutral-500">
                  {t(m.hint)}
                </span>
              </span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "sessions",
      label: t("Sort sessions by"),
      text: `sort order list ${SESSION_SORTS.map((s) => t(s.label)).join(" ")}`,
      node: (
        <div role="radiogroup" aria-labelledby="session-sort-label">
          <div
            id="session-sort-label"
            className="px-2 pt-1 pb-1 text-ui text-neutral-300"
          >
            {t("Sort sessions by")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Choose the order of unpinned sessions in the sidebar. Pinned sessions stay at the top.",
              )}
            </span>
          </div>
          {SESSION_SORTS.map((s) => (
            <OptionRow key={s.id} selected={s.id === sessionSort}>
              <input
                type="radio"
                name="sessionSort"
                value={s.id}
                checked={s.id === sessionSort}
                onChange={() => onSessionSort(s.id)}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span className="flex-1">{t(s.label)}</span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "sessions",
      label: t("Unnamed session titles"),
      text: `name first latest last recent prompt message ${t("First prompt")} ${t("Latest prompt")} ${t("Use the first or latest prompt for unnamed sessions. Renaming a session overrides this choice.")}`,
      node: (
        <div role="radiogroup" aria-labelledby="session-titles-label">
          <div
            id="session-titles-label"
            className="px-2 pt-1 pb-1 text-ui text-neutral-300"
          >
            {t("Unnamed session titles")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Use the first or latest prompt for unnamed sessions. Renaming a session overrides this choice.",
              )}
            </span>
          </div>
          {[
            { latest: false, label: t("First prompt") },
            { latest: true, label: t("Latest prompt") },
          ].map((m) => (
            <OptionRow key={m.label} selected={m.latest === latestPrompt}>
              <input
                type="radio"
                name="sessionTitles"
                checked={m.latest === latestPrompt}
                onChange={() => onLatestPrompt(m.latest)}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span className="flex-1">{m.label}</span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "sessions",
      label: t("Session title lines"),
      text: `session list name wrap new line multiline ${t("Maximum lines per sidebar title. All shows the full title.")} ${t("All")}`,
      node: (
        <div role="radiogroup" aria-labelledby="session-lines-label">
          <div
            id="session-lines-label"
            className="px-2 pt-1 pb-1 text-ui text-neutral-300"
          >
            {t("Session title lines")}
            <span className="block text-meta text-neutral-500">
              {t("Maximum lines per sidebar title. All shows the full title.")}
            </span>
          </div>
          {SESSION_LINES.map((m) => (
            <OptionRow key={m.id} selected={m.id === sessionLines}>
              <input
                type="radio"
                name="sessionLines"
                value={m.id}
                checked={m.id === sessionLines}
                onChange={() => {
                  setSessionLines(m.id);
                  applySessionLines(m.id);
                }}
                className="size-3.5 shrink-0 accent-amber-400"
              />
              <span className="flex-1">{t(m.label)}</span>
            </OptionRow>
          ))}
        </div>
      ),
    },
    {
      category: "sessions",
      label: t("Show attachment previews"),
      text: `text image pasted files thumbnails ${t("Show text and image attachment chips in the session list.")}`,
      node: (
        <OptionRow>
          <input
            type="checkbox"
            checked={sessionAttachments}
            onChange={(e) => onSessionAttachments(e.target.checked)}
            className="size-4 shrink-0 accent-amber-400"
          />
          <span className="flex-1">
            {t("Show attachment previews")}
            <span className="block text-meta text-neutral-500">
              {t("Show text and image attachment chips in the session list.")}
            </span>
          </span>
        </OptionRow>
      ),
    },
    {
      category: "instructions",
      label: t("Agent instructions"),
      text: "global local project AGENTS.md agent.md instructions",
      node: <AgentInstructions cwd={cwd} open={open} />,
    },
    {
      category: "automatic",
      label: t("Automatic actions"),
      text: "commit naming message model session naming title model conversation summary compaction automatic summarize when context is full tool log reduction model provider gpt reducer compact rename history background SoL-Pi Packages",
      node: <AutomaticActions />,
    },
    {
      category: "tools",
      label: t("Native codemode"),
      text: "native codemode code mode codex notebook tools off on only",
      node: <CodemodeSettings open={open} />,
    },
    {
      category: "notifications",
      label: t("Notify when the agent finishes"),
      text: `alert desktop done ${notifyHint}`,
      node: (
        <div className="space-y-2">
          <OptionRow disabled={notifyBlocked || notificationPending}>
            <input
              type="checkbox"
              checked={notify && permission === "granted"}
              disabled={notificationPending || notifyBlocked}
              onChange={(e) => void changeNotifications(e.target.checked)}
              className="size-4 shrink-0 accent-amber-400"
            />
            <span className="flex-1">
              {t("Notify when the agent finishes")}
              <span className="block text-meta text-neutral-500">
                {notifyHint}
              </span>
            </span>
          </OptionRow>
          <Button
            size="sm"
            disabled={
              !notify || permission !== "granted" || notificationPending
            }
            onClick={testNotification}
          >
            {t("Send test notification")}
          </Button>
          {notificationStatus && (
            <p role="status" className="text-meta text-neutral-500">
              {notificationStatus}
            </p>
          )}
        </div>
      ),
    },
    {
      category: "general",
      label: t("Expand advanced controls by default"),
      text: "collapse open default advanced controls chat fade sliders",
      node: (
        <OptionRow>
          <input
            type="checkbox"
            checked={expandDetails}
            onChange={(e) => {
              setExpandDetails(e.target.checked);
              writeSettingsExpanded(e.target.checked);
            }}
            className="size-4 shrink-0 accent-amber-400"
          />
          <span className="flex-1">
            {t("Expand advanced controls by default")}
            <span className="block text-meta text-neutral-500">
              {t(
                "Open advanced controls automatically, such as the sliders for fading above the message box.",
              )}
            </span>
          </span>
        </OptionRow>
      ),
    },
    ...SHORTCUTS.map((s) => {
      const keys = bindings[s.id];
      const shown = keys && formatCombo(keys);
      const blocked = !!keys && isReserved(keys);
      const chip = "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-meta";
      let look = "bg-neutral-800 text-neutral-200";
      if (blocked) look = "animate-pulse bg-red-500/20 text-red-400";
      else if (!keys) look = "bg-neutral-800 text-neutral-500";
      return {
        category: "shortcuts" as const,
        label: t(s.label),
        text: `shortcut hotkey keys ${shown}`,
        node: (
          <div
            className={`flex items-center gap-1 rounded-sm py-1 pr-1 pl-2 text-ui hover:bg-neutral-900 ${recording === s.id ? "bg-neutral-900" : ""}`}
          >
            <span className="flex-1">{t(s.label)}</span>
            {recording === s.id ? (
              <kbd className={`${chip} bg-amber-900/40 text-amber-200`}>
                {t("Press keys…")}
              </kbd>
            ) : (
              <kbd
                title={
                  blocked
                    ? t(
                        "Your browser keeps {keys} for itself, so this shortcut will not work.",
                        { keys: shown },
                      )
                    : undefined
                }
                className={`${chip} ${look}`}
              >
                {shown || t("Blank")}
              </kbd>
            )}
            {keys !== s.keys && (
              <IconButton
                size="sm"
                label={t("Restore default")}
                onClick={() => setBindings(writeBinding(s.id, s.keys))}
              >
                <ArrowCounterClockwise size={14} />
              </IconButton>
            )}
            {keys && (
              <IconButton
                size="sm"
                label={t("Remove shortcut")}
                onClick={() => setBindings(writeBinding(s.id, ""))}
              >
                <X size={14} />
              </IconButton>
            )}
            <IconButton
              size="sm"
              label={t("Change shortcut")}
              onClick={() => setRecording(s.id)}
            >
              <PencilSimple size={14} />
            </IconButton>
          </div>
        ),
      };
    }),
  ];

  const searching = query.trim() !== "";
  const shown = items
    .map((i) => ({
      ...i,
      hit: searching
        ? matches(
            query,
            i.label,
            `${t(CATEGORIES.find((c) => c.id === i.category)?.label ?? "")} ${i.group ?? ""} ${i.text}`,
          )
        : i.category === category && ("none" as const),
    }))
    .filter((i) => i.hit);
  const hitCategories = new Set(shown.map((i) => i.category));

  // Paint matches with the CSS Custom Highlight API (see `::highlight(settings-search)`
  // in index.css): ranges over the rendered text, so no setting's markup has to know
  // about search.
  useLayoutEffect(() => {
    const root = results.current;
    if (!root || typeof Highlight === "undefined") return;
    const ranges = highlightRanges(root, query);
    if (!ranges.length) return;
    CSS.highlights.set("settings-search", new Highlight(...ranges));
    return () => void CSS.highlights.delete("settings-search");
  });

  return (
    <section
      aria-label={t("Settings")}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
    >
      <PanelHeader title={t("Settings")} onClose={onClose} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("Settings categories")}
          className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-neutral-800 p-2"
        >
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears a query first; a cancelled keydown fires no
              // close request on the page <dialog>.
              if (e.key !== "Escape" || !query) return;
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }}
            placeholder={t("Search settings")}
            aria-label={t("Search settings")}
            className={`mb-2 w-full ${inputClass.sm}`}
          />
          {CATEGORIES.map((c) => (
            <NavItem
              key={c.id}
              icon={c.icon}
              selected={!searching && c.id === category}
              // While searching, categories without a hit fade, so the list
              // doubles as a map of where the matches are.
              className={
                searching && !hitCategories.has(c.id) ? "opacity-50" : ""
              }
              onClick={() => {
                setQuery("");
                setCategory(c.id);
              }}
            >
              {t(c.label)}
            </NavItem>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div
            ref={results}
            className={`mx-auto w-full p-6 ${shown.some((item) => item.category === "instructions") ? "" : "max-w-xl"}`}
          >
            {searching && !shown.length && (
              <p className="px-2 text-ui text-neutral-500">
                {t("No settings match “{query}”.", { query: query.trim() })}
              </p>
            )}
            {CATEGORIES.filter((c) => hitCategories.has(c.id)).map((c, n) => (
              <Section
                key={c.id}
                title={t(c.label)}
                className={n ? "mt-6" : ""}
              >
                <p className="mb-4 px-2 text-meta text-neutral-500">
                  {t(CATEGORY_HINTS[c.id])}
                </p>
                <div className="flex flex-col gap-2">
                  {Array.from(
                    new Set(
                      shown
                        .filter((i) => i.category === c.id)
                        .map((i) => i.group),
                    ),
                  ).map((group) => {
                    const nodes = shown
                      .filter((i) => i.category === c.id && i.group === group)
                      .map((i) => (
                        <div
                          key={i.label}
                          data-hit={i.hit}
                          data-label={i.label}
                        >
                          {i.node}
                        </div>
                      ));
                    return group ? (
                      <Section
                        key={group}
                        title={group}
                        className="mt-4 border-t border-neutral-800 pt-4"
                      >
                        <div className="flex flex-col gap-2">{nodes}</div>
                      </Section>
                    ) : (
                      <div key="ungrouped" className="flex flex-col gap-2">
                        {nodes}
                      </div>
                    );
                  })}
                </div>
              </Section>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Lowercase without accents, so "frappe" finds "Frappé". */
const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Every word of the query somewhere in the label or text, or — for typos and
 * abbreviations like "shthk" — the whole query as a subsequence of the label.
 * Fuzzy only on the label: over a paragraph of hint text nearly anything
 * would be a subsequence.
 */
export function matches(
  query: string,
  label: string,
  text: string,
): "words" | "fuzzy" | null {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const all = fold(`${label} ${text}`);
  if (terms.every((t) => all.includes(t))) return "words";
  const needle = terms.join("");
  if (needle.length < 3) return null;
  let i = 0;
  for (const c of fold(label))
    if (c === needle[i] && ++i === needle.length) return "fuzzy";
  return null;
}

/**
 * Ranges to highlight under `root`: every query word in the visible text, except
 * in a fuzzy hit, where it is the subsequence's letters in the setting's name.
 */
function highlightRanges(root: HTMLElement, query: string): Range[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const needle = terms.join("");
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    // Folded char by char, keeping each folded char's index in the raw text,
    // so a match in "frappe" lands on "Frappé".
    const map: number[] = [];
    let folded = "";
    for (let i = 0; i < node.data.length; i++) {
      const f = fold(node.data[i]);
      folded += f;
      for (let k = 0; k < f.length; k++) map.push(i);
    }
    const add = (from: number, to: number) => {
      const r = new Range();
      r.setStart(node, map[from]);
      r.setEnd(node, map[to - 1] + 1);
      ranges.push(r);
    };
    const item = node.parentElement?.closest<HTMLElement>("[data-hit]");
    if (item?.dataset.hit === "fuzzy") {
      if (folded.trim() !== fold(item.dataset.label ?? "")) continue;
      let i = 0;
      for (let at = 0; at < folded.length && i < needle.length; at++)
        if (folded[at] === needle[i]) {
          add(at, at + 1);
          i++;
        }
      continue;
    }
    for (const t of terms)
      for (
        let at = folded.indexOf(t);
        at >= 0;
        at = folded.indexOf(t, at + t.length)
      )
        add(at, at + t.length);
  }
  return ranges;
}
