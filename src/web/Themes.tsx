import { useState, type CSSProperties } from "react";

import { t } from "./i18n.js";
import {
  editorThemeOf,
  MATCH_APP,
  paletteVars,
  syntaxThemeOf,
  THEMES,
  VSCODE_THEMES,
  type ThemeId,
} from "./prefs.js";
import { Button, inputClass, PanelHeader } from "./ui.js";
import {
  SYNTAX_ROLES,
  type ConvertedTheme,
  type SyntaxRole,
} from "./vscodeTheme.js";

/** The preview snippet, pre-tokenized: each piece is its text and the syntax role VS Code gives it. */
type Piece = [string, SyntaxRole?];
const SNIPPET: Piece[][] = [
  [
    ["const", "definitionKeyword"],
    [" "],
    ["btn", "variable"],
    [" "],
    ["=", "operator"],
    [" "],
    ["document", "variable"],
    [".", "punctuation"],
    ["getElementById", "function"],
    ["(", "punctuation"],
    ["'btn'", "string"],
    [");", "punctuation"],
  ],
  [
    ["let", "definitionKeyword"],
    [" "],
    ["count", "variable"],
    [" "],
    ["=", "operator"],
    [" "],
    ["0", "number"],
    [";", "punctuation"],
  ],
  [],
  [
    ["function", "definitionKeyword"],
    [" "],
    ["render", "function"],
    ["() {", "punctuation"],
  ],
  [
    ["  "],
    ["btn", "variable"],
    [".", "punctuation"],
    ["innerText", "property"],
    [" "],
    ["=", "operator"],
    [" "],
    ["`Count: ", "templateString"],
    ["${", "keyword"],
    ["count", "variable"],
    ["}", "keyword"],
    ["`", "templateString"],
    [";", "punctuation"],
  ],
  [["}", "punctuation"]],
  [],
  [
    ["btn", "variable"],
    [".", "punctuation"],
    ["addEventListener", "function"],
    ["(", "punctuation"],
    ["'click'", "string"],
    [", () ", "punctuation"],
    ["=>", "definitionKeyword"],
    [" {", "punctuation"],
  ],
  [["  "], ["// Count from 1 to 10.", "comment"]],
  [
    ["  "],
    ["if", "controlKeyword"],
    [" (", "punctuation"],
    ["count", "variable"],
    [" "],
    ["<", "operator"],
    [" "],
    ["10", "number"],
    [") {", "punctuation"],
  ],
  [
    ["    "],
    ["count", "variable"],
    [" "],
    ["+=", "operator"],
    [" "],
    ["1", "number"],
    [";", "punctuation"],
  ],
  [["    "], ["render", "function"], ["();", "punctuation"]],
  [["  }", "punctuation"]],
  [["});", "punctuation"]],
];

/** A role's color and font style in a theme, as the editor would paint it. */
function pieceStyle(
  th: ConvertedTheme,
  role: SyntaxRole | undefined,
): CSSProperties | undefined {
  if (!role) return undefined;
  const [color, flags] = th.syntax[SYNTAX_ROLES.indexOf(role)].split("|");
  return {
    color: color || undefined,
    fontStyle: flags.includes("i") ? "italic" : undefined,
    fontWeight: flags.includes("b") ? "bold" : undefined,
  };
}

/**
 * One theme as a card: the app's chrome in its palette (title bar, rail with
 * the accent lit, accent status bar) around the snippet in its editor colors.
 */
function ThemeCard({
  id,
  label,
  current,
  editor,
  onTheme,
  onEditor,
}: {
  id: ThemeId;
  label: string;
  /** The app wears it. */
  current: boolean;
  /** The editor wears it as a theme of its own. */
  editor: boolean;
  onTheme: () => void;
  onEditor: () => void;
}) {
  const code = VSCODE_THEMES[syntaxThemeOf(id)];
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-custom="theme card preview"
        onClick={onTheme}
        aria-pressed={current}
        aria-label={t("Use {name}", { name: label })}
        className={`overflow-hidden rounded-md border text-left ${current ? "border-amber-400" : "border-neutral-800 hover:border-neutral-600"}`}
      >
        {/* A VS Code theme's palette is not in index.css, so it comes along inline. */}
        <div
          data-theme={id}
          style={paletteVars(id) as CSSProperties}
          className="flex flex-col"
        >
          <div className="h-4 border-b border-neutral-800 bg-neutral-950" />
          <div className="flex">
            <div className="flex w-6 flex-col items-center gap-2 bg-neutral-950 py-2">
              <span className="size-2 rounded-full bg-amber-400" />
              <span className="size-2 rounded-full bg-neutral-600" />
              <span className="size-2 rounded-full bg-neutral-600" />
            </div>
            <pre
              className="min-w-0 flex-1 overflow-hidden p-3 font-mono text-caption"
              style={{ background: code.editor[0], color: code.editor[1] }}
            >
              {SNIPPET.map((line, i) => (
                <div key={i} className="whitespace-pre">
                  {line.length
                    ? line.map(([text, role], j) => (
                        <span key={j} style={pieceStyle(code, role)}>
                          {text}
                        </span>
                      ))
                    : " "}
                </div>
              ))}
            </pre>
          </div>
          <div className="h-3 bg-amber-400" />
        </div>
      </button>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-ui text-neutral-100">{label}</span>
        {editor ? (
          <span className="text-meta text-amber-400">{t("Editor")}</span>
        ) : (
          <Button size="sm" variant="ghost" onClick={onEditor}>
            {t("Use for editor")}
          </Button>
        )}
      </div>
    </div>
  );
}

const FILTERS = [
  { id: "all", label: "All" },
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
] as const;

/**
 * Every theme as a card. Clicking one themes the whole app, and the editor
 * with it while the editor matches the app; "Use for editor" gives the editor
 * that theme on its own.
 */
export function Themes({
  theme,
  onTheme,
  editorTheme,
  onEditorTheme,
  onClose,
}: {
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
  editorTheme: string;
  onEditorTheme: (theme: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const q = query.trim().toLowerCase();
  const shown = THEMES.filter(
    (th) =>
      (filter === "all" || th.light === (filter === "light")) &&
      (!q || th.label.toLowerCase().includes(q)),
  );
  return (
    <section
      aria-label={t("Themes")}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
    >
      <PanelHeader title={t("Themes")} onClose={onClose}>
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
          placeholder={t("Search themes")}
          aria-label={t("Search themes")}
          className={`w-56 ${inputClass.sm}`}
        />
        {FILTERS.map((f) => (
          <Button
            key={f.id}
            size="sm"
            variant={filter === f.id ? "subtle" : "ghost"}
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
          >
            {t(f.label)}
          </Button>
        ))}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!shown.length && (
          <p className="text-ui text-neutral-500">
            {t("No themes match “{query}”.", { query: query.trim() })}
          </p>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
          {shown.map((th) => (
            <ThemeCard
              key={th.id}
              id={th.id}
              label={th.label}
              current={th.id === theme}
              editor={
                editorTheme !== MATCH_APP &&
                editorThemeOf(theme, editorTheme) === syntaxThemeOf(th.id)
              }
              onTheme={() => onTheme(th.id)}
              onEditor={() => onEditorTheme(syntaxThemeOf(th.id))}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
