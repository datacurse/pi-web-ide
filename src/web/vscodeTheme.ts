/**
 * VS Code color themes, mapped onto pwi's own color slots.
 *
 * A VS Code theme has two halves: `colors` (hundreds of workbench keys) and
 * `tokenColors` (TextMate scope rules for syntax). pwi needs three things out
 * of it, and this module is the one place that knows how to get them:
 *
 * - `palette`: the 18 `--ct-*` slots index.css maps Tailwind onto, so the
 *   whole app can wear the theme.
 * - `syntax`: one color (plus italic/bold/underline) per SYNTAX_SCOPES role,
 *   which codemirror.ts turns into a HighlightStyle of CSS variables.
 * - `editor`: the code editor's chrome (background, gutter, selection…).
 *
 * Run at build time by scripts/vscode-themes.ts over @shikijs/themes; the
 * output is src/web/vscodeThemes.json. Pure data in, pure data out, so the
 * same function can convert a theme a user pastes in later.
 */

export interface VsTheme {
  displayName?: string;
  name?: string;
  type?: string;
  colors?: Record<string, string>;
  tokenColors?: TokenRule[];
  /** The older tmTheme spelling of `tokenColors`. */
  settings?: TokenRule[];
}

interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: string; background?: string; fontStyle?: string };
}

export interface ConvertedTheme {
  label: string;
  light: boolean;
  /** In PALETTE_KEYS order, opaque `#rrggbb`. */
  palette: string[];
  /** In SYNTAX_ROLES order: `"#color|flags"`, flags from `ibus` (italic, bold, underline, strike); either part may be empty. */
  syntax: string[];
  /** In EDITOR_KEYS order; may carry alpha. */
  editor: string[];
}

/** index.css's `--ct-*` slots. */
export const PALETTE_KEYS = [
  "base",
  "mantle",
  "surface0",
  "surface1",
  "overlay0",
  "overlay1",
  "overlay2",
  "subtext0",
  "subtext1",
  "text",
  "red",
  "peach",
  "yellow",
  "green",
  "teal",
  "blue",
  "lavender",
  "mauve",
] as const;

/**
 * Syntax roles and the TextMate scopes that color them, most specific first:
 * the first scope any rule of the theme matches decides. Each role is one
 * `--tk-<role>` variable; codemirror.ts says which Lezer tags wear it.
 */
export const SYNTAX_SCOPES = {
  comment: ["comment"],
  docComment: ["comment.block.documentation", "comment"],
  keyword: ["keyword"],
  controlKeyword: ["keyword.control"],
  moduleKeyword: ["keyword.control.import", "keyword.control"],
  operatorKeyword: [
    "keyword.operator.expression.typeof",
    "keyword.operator.new",
  ],
  definitionKeyword: ["storage.type"],
  modifier: ["storage.modifier"],
  self: ["variable.language"],
  constantLanguage: ["constant.language"],
  atom: ["support.constant.property-value", "constant.language"],
  string: ["string"],
  templateString: ["string.template", "string"],
  regexp: ["string.regexp"],
  escape: ["constant.character.escape"],
  number: ["constant.numeric"],
  function: ["entity.name.function", "support.function"],
  variable: ["variable.other.readwrite", "variable"],
  property: [
    "variable.other.property",
    "support.type.property-name",
    "variable",
  ],
  attribute: ["entity.other.attribute-name"],
  type: ["entity.name.type", "support.type"],
  class: ["entity.name.type.class", "entity.name.class", "entity.name.type"],
  namespace: [
    "entity.name.namespace",
    "entity.name.type.module",
    "entity.name.type",
  ],
  tag: ["entity.name.tag"],
  tagBracket: ["punctuation.definition.tag"],
  constant: ["variable.other.constant", "constant.other", "constant"],
  label: ["entity.name.label"],
  macro: [
    "entity.name.function.preprocessor",
    "meta.preprocessor",
    "keyword.control.directive",
  ],
  operator: ["keyword.operator"],
  punctuation: ["punctuation"],
  invalid: ["invalid"],
  heading: ["markup.heading", "entity.name.section"],
  link: ["markup.underline.link", "string.other.link"],
  quote: ["markup.quote"],
  monospace: ["markup.inline.raw"],
  emphasis: ["markup.italic"],
  strong: ["markup.bold"],
  strikethrough: ["markup.strikethrough"],
} as const;

export type SyntaxRole = keyof typeof SYNTAX_SCOPES;

export const SYNTAX_ROLES = Object.keys(SYNTAX_SCOPES) as SyntaxRole[];

/** Markdown roles keep their meaning when a theme gives them no style. */
const DEFAULT_FLAGS: Partial<Record<SyntaxRole, string>> = {
  heading: "b",
  link: "u",
  emphasis: "i",
  strong: "b",
  strikethrough: "s",
};

/** The editor's `--ed-*` variables, each read from a VS Code key. */
const EDITOR_SOURCE = {
  bg: "editor.background",
  fg: "editor.foreground",
  gutter: "editorLineNumber.foreground",
  "gutter-active": "editorLineNumber.activeForeground",
  line: "editor.lineHighlightBackground",
  cursor: "editorCursor.foreground",
  selection: "editor.selectionBackground",
  "selection-inactive": "editor.inactiveSelectionBackground",
  "selection-match": "editor.selectionHighlightBackground",
  bracket: "editorBracketMatch.background",
  "bracket-border": "editorBracketMatch.border",
  widget: "editorWidget.background",
  "widget-fg": "editorWidget.foreground",
  "widget-border": "editorWidget.border",
  input: "input.background",
  "list-active": "list.activeSelectionBackground",
  "list-active-fg": "list.activeSelectionForeground",
} as const;

export const EDITOR_KEYS = Object.keys(
  EDITOR_SOURCE,
) as (keyof typeof EDITOR_SOURCE)[];

/** VS Code's built-in values for every key read here, used when a theme leaves one out. */
const VS_DEFAULTS: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "editorLineNumber.foreground": "#858585",
    "editorLineNumber.activeForeground": "#c6c6c6",
    "editor.lineHighlightBackground": "#ffffff0a",
    "editorCursor.foreground": "#aeafad",
    "editor.selectionBackground": "#264f78",
    "editor.inactiveSelectionBackground": "#3a3d41",
    "editor.selectionHighlightBackground": "#add6ff26",
    "editorBracketMatch.background": "#0064001a",
    "editorBracketMatch.border": "#888888",
    "editorWidget.background": "#252526",
    "editorWidget.foreground": "#cccccc",
    "editorWidget.border": "#454545",
    "input.background": "#3c3c3c",
    "list.activeSelectionBackground": "#04395e",
    "list.activeSelectionForeground": "#ffffff",
    "terminal.ansiRed": "#cd3131",
    "terminal.ansiGreen": "#0dbc79",
    "terminal.ansiYellow": "#e5e510",
    "terminal.ansiBlue": "#2472c8",
    "terminal.ansiMagenta": "#bc3fbc",
    "terminal.ansiCyan": "#11a8cd",
    "terminal.ansiBrightBlue": "#3b8eea",
  },
  light: {
    "editor.background": "#ffffff",
    "editor.foreground": "#000000",
    "editorLineNumber.foreground": "#237893",
    "editorLineNumber.activeForeground": "#0b216f",
    "editor.lineHighlightBackground": "#0000000a",
    "editorCursor.foreground": "#000000",
    "editor.selectionBackground": "#add6ff",
    "editor.inactiveSelectionBackground": "#e5ebf1",
    "editor.selectionHighlightBackground": "#add6ff80",
    "editorBracketMatch.background": "#0064001a",
    "editorBracketMatch.border": "#b9b9b9",
    "editorWidget.background": "#f3f3f3",
    "editorWidget.foreground": "#616161",
    "editorWidget.border": "#c8c8c8",
    "input.background": "#ffffff",
    "list.activeSelectionBackground": "#0060c0",
    "list.activeSelectionForeground": "#ffffff",
    "terminal.ansiRed": "#cd3131",
    "terminal.ansiGreen": "#00bc00",
    "terminal.ansiYellow": "#949800",
    "terminal.ansiBlue": "#0451a5",
    "terminal.ansiMagenta": "#bc05bc",
    "terminal.ansiCyan": "#0598bc",
    "terminal.ansiBrightBlue": "#0451a5",
  },
};

type Rgba = [number, number, number, number];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function parse(value: string | undefined): Rgba | undefined {
  if (!value || !HEX.test(value)) return undefined;
  let h = value.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

/** A color laid over `under`, so a translucent key still yields a solid slot. */
function solid(c: Rgba, under: Rgba): Rgba {
  const a = c[3];
  return [0, 1, 2].map((i) => c[i] * a + under[i] * (1 - a)).concat(1) as Rgba;
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t).concat(1) as Rgba;
}

function hex(c: Rgba): string {
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(Math.min(255, Math.max(0, c[i])))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function luminance(c: Rgba): number {
  const [r, g, b] = [0, 1, 2].map((i) => {
    const v = c[i] / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgba, b: Rgba): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

function saturation(c: Rgba): number {
  const max = Math.max(c[0], c[1], c[2]) / 255;
  const min = Math.min(c[0], c[1], c[2]) / 255;
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

/** Pushed toward the text color until it reads on the background at 3:1. */
function readable(c: Rgba, base: Rgba, text: Rgba): Rgba {
  let out = c;
  for (let t = 0.1; contrast(out, base) < 3 && t <= 1; t += 0.1)
    out = mix(c, text, t);
  return out;
}

/** Simple selectors of a rule; descendant selectors (`source.js string`) need context this has not got. */
function selectors(rule: TokenRule): string[] {
  const raw = Array.isArray(rule.scope)
    ? rule.scope
    : (rule.scope ?? "").split(",");
  return raw.map((s) => s.trim()).filter((s) => s && !s.includes(" "));
}

/** TextMate matching: the longest selector that is a dot-prefix of the scope wins, later rules break ties. */
function lookup(
  rules: TokenRule[],
  scope: string,
  prop: "foreground" | "fontStyle",
): string | undefined {
  let best = -1;
  let value: string | undefined;
  for (const rule of rules) {
    const v = rule.settings?.[prop];
    if (v === undefined) continue;
    for (const sel of selectors(rule)) {
      if (
        (scope === sel || scope.startsWith(`${sel}.`)) &&
        sel.length >= best
      ) {
        best = sel.length;
        value = v;
      }
    }
  }
  return value;
}

function flags(fontStyle: string): string {
  const words = fontStyle.split(/\s+/);
  return [
    words.includes("italic") ? "i" : "",
    words.includes("bold") ? "b" : "",
    words.includes("underline") ? "u" : "",
    words.includes("strikethrough") ? "s" : "",
  ].join("");
}

export function convertTheme(theme: VsTheme): ConvertedTheme {
  const light = theme.type === "light";
  const colors = theme.colors ?? {};
  const rules = theme.tokenColors ?? theme.settings ?? [];
  const plain = rules.find((r) => !r.scope)?.settings ?? {};
  const defaults = VS_DEFAULTS[light ? "light" : "dark"];
  /** The first key the theme sets to a usable color, else VS Code's default for the last one. */
  const raw = (...keys: string[]): string | undefined => {
    for (const k of keys) if (parse(colors[k])) return colors[k];
    return defaults[keys[keys.length - 1]];
  };

  const black: Rgba = [0, 0, 0, 1];
  const base = solid(
    parse(colors["editor.background"] ?? plain.background) ??
      parse(defaults["editor.background"])!,
    black,
  );
  const text = solid(
    parse(colors["editor.foreground"] ?? plain.foreground) ??
      parse(defaults["editor.foreground"])!,
    base,
  );
  const on = (...keys: string[]) => solid(parse(raw(...keys))!, base);

  // The backdrop sits one step below the editor: the sidebar when the theme
  // makes it darker, else the editor background darkened by hand.
  const side = parse(colors["sideBar.background"]);
  const mantle =
    side && luminance(solid(side, base)) < luminance(base) - 0.002
      ? solid(side, base)
      : mix(base, black, light ? 0.04 : 0.2);

  // Greys: evenly spaced from background to text, which keeps the theme's tint.
  const ramp = [0.11, 0.22, 0.45, 0.55, 0.67, 0.78, 0.89].map((t) =>
    mix(base, text, t),
  );

  // The accent is whatever the theme uses for its own emphasis — a badge, a
  // button, the focus ring — skipping ones that are grey.
  const accentKeys = [
    "activityBarBadge.background",
    "button.background",
    "focusBorder",
    "textLink.foreground",
  ];
  const accent =
    accentKeys
      .map((k) => parse(colors[k]))
      .find((c) => c && saturation(solid(c, base)) >= 0.35) ??
    parse(raw("terminal.ansiYellow"))!;

  const accents = [
    on("terminal.ansiRed"),
    solid(accent, base),
    on("terminal.ansiYellow"),
    on("terminal.ansiGreen"),
    on("terminal.ansiCyan"),
    on("terminal.ansiBlue"),
    on("terminal.ansiBrightBlue"),
    on("terminal.ansiMagenta"),
  ].map((c) => readable(c, base, text));

  const syntax = SYNTAX_ROLES.map((role) => {
    const scopes: readonly string[] = SYNTAX_SCOPES[role];
    const color = scopes
      .map((s) => lookup(rules, s, "foreground"))
      .find((v) => parse(v));
    const style = scopes
      .map((s) => lookup(rules, s, "fontStyle"))
      .find((v) => v !== undefined);
    return `${color ?? ""}|${style === undefined ? (DEFAULT_FLAGS[role] ?? "") : flags(style)}`;
  });

  const editor = EDITOR_KEYS.map((k) => {
    if (k === "bg") return hex(base);
    if (k === "fg") return hex(text);
    const key = EDITOR_SOURCE[k];
    return (parse(colors[key]) ? colors[key] : defaults[key]).toLowerCase();
  });

  return {
    label: theme.displayName ?? theme.name ?? "",
    light,
    palette: [base, mantle, ...ramp, text, ...accents].map(hex),
    syntax,
    editor,
  };
}
