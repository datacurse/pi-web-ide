/**
 * codemirror.ts — the editor, loaded once, on demand.
 *
 * Shared by the editor (FileEditor.tsx) and diff tabs (DiffView.tsx) so there
 * is ONE module-level promise: two loaders would mean two copies of
 * `@codemirror/state` in the graph, and CodeMirror facets are identity-keyed —
 * an extension built against one copy is silently inert in a view built by the
 * other, which presents as a dead editor rather than an error.
 *
 * Same lazy trade as xterm (Terminal.tsx) and KaTeX (Math.tsx): a session that
 * never opens a file should not pay for the editor, and the cached promise
 * makes every open after the first instant.
 */

import type { HighlightStyle } from "@codemirror/language";
import type {
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
} from "@codemirror/view";
import type { Tag } from "@lezer/highlight";

import { SYNTAX_ROLES, type SyntaxRole } from "./vscodeTheme.js";

export interface CmModules {
  HighlightStyle: typeof import("@codemirror/language").HighlightStyle;
  tags: typeof import("@lezer/highlight").tags;
  EditorView: typeof import("@codemirror/view").EditorView;
  lineNumbers: typeof import("@codemirror/view").lineNumbers;
  highlightActiveLine: typeof import("@codemirror/view").highlightActiveLine;
  keymap: typeof import("@codemirror/view").keymap;
  drawSelection: typeof import("@codemirror/view").drawSelection;
  ViewPlugin: typeof import("@codemirror/view").ViewPlugin;
  Decoration: typeof import("@codemirror/view").Decoration;
  countColumn: typeof import("@codemirror/state").countColumn;
  EditorState: typeof import("@codemirror/state").EditorState;
  Compartment: typeof import("@codemirror/state").Compartment;
  unifiedMergeView: typeof import("@codemirror/merge").unifiedMergeView;
  syntaxHighlighting: typeof import("@codemirror/language").syntaxHighlighting;
  defaultHighlightStyle: typeof import("@codemirror/language").defaultHighlightStyle;
  indentOnInput: typeof import("@codemirror/language").indentOnInput;
  bracketMatching: typeof import("@codemirror/language").bracketMatching;
  foldGutter: typeof import("@codemirror/language").foldGutter;
  defaultKeymap: typeof import("@codemirror/commands").defaultKeymap;
  historyKeymap: typeof import("@codemirror/commands").historyKeymap;
  indentWithTab: typeof import("@codemirror/commands").indentWithTab;
  history: typeof import("@codemirror/commands").history;
  searchKeymap: typeof import("@codemirror/search").searchKeymap;
  highlightSelectionMatches: typeof import("@codemirror/search").highlightSelectionMatches;
  autocompletion: typeof import("@codemirror/autocomplete").autocompletion;
  closeBrackets: typeof import("@codemirror/autocomplete").closeBrackets;
  closeBracketsKeymap: typeof import("@codemirror/autocomplete").closeBracketsKeymap;
  completionKeymap: typeof import("@codemirror/autocomplete").completionKeymap;
}

let loading: Promise<CmModules> | null = null;

export function loadCodeMirror(): Promise<CmModules> {
  loading ??= Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/merge"),
    import("@codemirror/language"),
    import("@codemirror/commands"),
    import("@codemirror/search"),
    import("@codemirror/autocomplete"),
    import("@lezer/highlight"),
  ]).then(
    ([
      view,
      state,
      merge,
      lang,
      commands,
      search,
      autocomplete,
      highlight,
    ]) => ({
      HighlightStyle: lang.HighlightStyle,
      tags: highlight.tags,
      EditorView: view.EditorView,
      lineNumbers: view.lineNumbers,
      highlightActiveLine: view.highlightActiveLine,
      keymap: view.keymap,
      drawSelection: view.drawSelection,
      ViewPlugin: view.ViewPlugin,
      Decoration: view.Decoration,
      countColumn: state.countColumn,
      EditorState: state.EditorState,
      Compartment: state.Compartment,
      unifiedMergeView: merge.unifiedMergeView,
      syntaxHighlighting: lang.syntaxHighlighting,
      defaultHighlightStyle: lang.defaultHighlightStyle,
      indentOnInput: lang.indentOnInput,
      bracketMatching: lang.bracketMatching,
      foldGutter: lang.foldGutter,
      defaultKeymap: commands.defaultKeymap,
      historyKeymap: commands.historyKeymap,
      indentWithTab: commands.indentWithTab,
      history: commands.history,
      searchKeymap: search.searchKeymap,
      highlightSelectionMatches: search.highlightSelectionMatches,
      autocompletion: autocomplete.autocompletion,
      closeBrackets: autocomplete.closeBrackets,
      closeBracketsKeymap: autocomplete.closeBracketsKeymap,
      completionKeymap: autocomplete.completionKeymap,
    }),
  );
  return loading;
}

/**
 * Wrapped lines continue at their own indentation, not at column 0.
 *
 * Each visible line gets its leading-whitespace width as `--indent`; the
 * `.cm-wrapIndent` rule in index.css turns that into a hanging indent and
 * draws a wrap marker at the start of every continuation row.
 */
export function wrapIndent(cm: CmModules) {
  const cache = new Map<number, Decoration>();
  const deco = (cols: number) => {
    let d = cache.get(cols);
    if (!d) {
      d = cm.Decoration.line({
        class: "cm-wrapIndent",
        attributes: { style: `--indent: ${cols}ch` },
      });
      cache.set(cols, d);
    }
    return d;
  };
  const build = (view: EditorView): DecorationSet => {
    const ranges = [];
    let last = -1;
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to;) {
        const line = view.state.doc.lineAt(pos);
        if (line.from > last) {
          const ws = /^[ \t]*/.exec(line.text)?.[0] ?? "";
          ranges.push(
            deco(cm.countColumn(ws, view.state.tabSize)).range(line.from),
          );
          last = line.from;
        }
        pos = line.to + 1;
      }
    }
    return cm.Decoration.set(ranges);
  };
  return cm.ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/**
 * Syntax colors as CSS variables, so a theme switch recolors every open
 * editor, diff and chat code block without rebuilding a view.
 *
 * Each role of SYNTAX_SCOPES (vscodeTheme.ts) is one `--<prefix>-<role>`
 * color plus optional `-fs`/`-fw`/`-td`, written onto <html> by applyTheme
 * (prefs.ts). An unset variable makes its property fall back to the
 * surrounding text, which is what a theme that leaves a role uncolored means.
 * `tk` is the app theme's syntax (chat, diffs), `etk` the editor's own.
 */
const SYNTAX_TAGS: Record<SyntaxRole, (t: CmModules["tags"]) => Tag[]> = {
  comment: (t) => [t.comment, t.lineComment, t.blockComment],
  docComment: (t) => [t.docComment],
  keyword: (t) => [t.keyword],
  controlKeyword: (t) => [t.controlKeyword],
  moduleKeyword: (t) => [t.moduleKeyword],
  operatorKeyword: (t) => [t.operatorKeyword],
  definitionKeyword: (t) => [t.definitionKeyword],
  modifier: (t) => [t.modifier],
  self: (t) => [t.self],
  constantLanguage: (t) => [t.null, t.bool],
  atom: (t) => [t.atom],
  string: (t) => [t.string, t.attributeValue],
  templateString: (t) => [t.special(t.string)],
  regexp: (t) => [t.regexp],
  escape: (t) => [t.escape],
  number: (t) => [t.number, t.integer, t.float],
  function: (t) => [
    t.function(t.variableName),
    t.function(t.propertyName),
    t.definition(t.function(t.variableName)),
  ],
  variable: (t) => [t.variableName, t.definition(t.variableName)],
  property: (t) => [t.propertyName, t.definition(t.propertyName)],
  attribute: (t) => [t.attributeName],
  type: (t) => [t.typeName, t.standard(t.typeName)],
  class: (t) => [t.className],
  namespace: (t) => [t.namespace],
  tag: (t) => [t.tagName],
  tagBracket: (t) => [t.angleBracket],
  constant: (t) => [t.constant(t.variableName)],
  label: (t) => [t.labelName],
  macro: (t) => [t.macroName],
  operator: (t) => [t.operator],
  punctuation: (t) => [t.punctuation, t.separator, t.bracket],
  invalid: (t) => [t.invalid],
  heading: (t) => [t.heading],
  link: (t) => [t.link, t.url],
  quote: (t) => [t.quote],
  monospace: (t) => [t.monospace],
  emphasis: (t) => [t.emphasis],
  strong: (t) => [t.strong],
  strikethrough: (t) => [t.strikethrough],
};

const styles = new Map<string, HighlightStyle>();

export function syntaxStyle(
  cm: CmModules,
  prefix: "tk" | "etk",
): HighlightStyle {
  let style = styles.get(prefix);
  if (!style) {
    style = cm.HighlightStyle.define(
      SYNTAX_ROLES.map((role) => {
        const v = `--${prefix}-${role}`;
        return {
          tag: SYNTAX_TAGS[role](cm.tags),
          color: `var(${v})`,
          fontStyle: `var(${v}-fs)`,
          fontWeight: `var(${v}-fw)`,
          textDecoration: `var(${v}-td)`,
        };
      }),
    );
    styles.set(prefix, style);
  }
  return style;
}

/**
 * Syntax highlighting for a path, or nothing.
 *
 * `@codemirror/language-data` is the stock table of every CodeMirror language
 * keyed by filename/extension, and each entry loads its own grammar on demand —
 * so a session that only ever opens TSX never downloads the Rust parser. An
 * extension nothing in the table matches still opens and still edits, just
 * without colour.
 */
export async function languageFor(path: string) {
  const [{ LanguageDescription }, { languages }] = await Promise.all([
    import("@codemirror/language"),
    import("@codemirror/language-data"),
  ]);
  const desc = LanguageDescription.matchFilename(
    languages,
    path.split("/").pop() ?? path,
  );
  if (!desc) return [];
  return [await desc.load()];
}
