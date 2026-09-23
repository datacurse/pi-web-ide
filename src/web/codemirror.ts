/**
 * codemirror.ts — the editor, loaded once, on demand.
 *
 * Shared by the editor (Editor.tsx) and the review pane (Review.tsx) so there
 * is ONE module-level promise: two loaders would mean two copies of
 * `@codemirror/state` in the graph, and CodeMirror facets are identity-keyed —
 * an extension built against one copy is silently inert in a view built by the
 * other, which presents as a dead editor rather than an error.
 *
 * Same lazy trade as xterm (Terminal.tsx) and KaTeX (Math.tsx): a session that
 * never opens a file should not pay for the editor, and the cached promise
 * makes every open after the first instant.
 */

export interface CmModules {
	HighlightStyle: typeof import("@codemirror/language").HighlightStyle;
	tags: typeof import("@lezer/highlight").tags;
	EditorView: typeof import("@codemirror/view").EditorView;
	lineNumbers: typeof import("@codemirror/view").lineNumbers;
	highlightActiveLine: typeof import("@codemirror/view").highlightActiveLine;
	keymap: typeof import("@codemirror/view").keymap;
	drawSelection: typeof import("@codemirror/view").drawSelection;
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
	]).then(([view, state, merge, lang, commands, search, autocomplete, highlight]) => ({
		HighlightStyle: lang.HighlightStyle,
		tags: highlight.tags,
		EditorView: view.EditorView,
		lineNumbers: view.lineNumbers,
		highlightActiveLine: view.highlightActiveLine,
		keymap: view.keymap,
		drawSelection: view.drawSelection,
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
	}));
	return loading;
}

/**
 * VS Code's Dark+ syntax colours.
 *
 * Written out here rather than pulled from a theme package, because a theme
 * package brings its OWN editor chrome — background, gutters, selection,
 * cursor — and would be the one panel in the app ignoring the CSS-variable
 * palette every other surface follows. That is the mistake Terminal.tsx
 * documents having made once with xterm. This is only the token colours; the
 * chrome stays in the `.cm-editor-host` block in index.css.
 *
 * The hexes are Dark+'s literal token colours, so they are deliberately NOT
 * CSS variables: a theme that recolours them is a different theme, not this
 * one. Switching the app palette to Latte will leave code looking like VS
 * Code, which is exactly what was asked for.
 *
 * ponytail: one hard-coded theme. If a second one is ever wanted, this becomes
 * a table keyed by theme id and a Compartment to swap it live.
 */
export function darkPlus(cm: CmModules) {
	const t = cm.tags;
	return cm.HighlightStyle.define([
		{ tag: t.comment, color: "#6a9955" },
		{ tag: t.lineComment, color: "#6a9955" },
		{ tag: t.blockComment, color: "#6a9955" },
		{ tag: t.docComment, color: "#6a9955" },
		// Keywords and operators share Dark+'s blue/magenta split: control flow
		// (if/return/for) is magenta, everything else keyword-ish is blue.
		{ tag: t.keyword, color: "#569cd6" },
		{ tag: t.controlKeyword, color: "#c586c0" },
		{ tag: t.moduleKeyword, color: "#c586c0" },
		{ tag: t.operatorKeyword, color: "#569cd6" },
		{ tag: t.definitionKeyword, color: "#569cd6" },
		{ tag: t.self, color: "#569cd6" },
		{ tag: t.null, color: "#569cd6" },
		{ tag: t.bool, color: "#569cd6" },
		{ tag: t.string, color: "#ce9178" },
		{ tag: t.special(t.string), color: "#d7ba7d" },
		{ tag: t.regexp, color: "#d16969" },
		{ tag: t.escape, color: "#d7ba7d" },
		{ tag: t.number, color: "#b5cea8" },
		{ tag: t.integer, color: "#b5cea8" },
		{ tag: t.float, color: "#b5cea8" },
		{ tag: t.function(t.variableName), color: "#dcdcaa" },
		{ tag: t.function(t.propertyName), color: "#dcdcaa" },
		{ tag: t.definition(t.function(t.variableName)), color: "#dcdcaa" },
		{ tag: t.definition(t.variableName), color: "#9cdcfe" },
		{ tag: t.variableName, color: "#9cdcfe" },
		{ tag: t.propertyName, color: "#9cdcfe" },
		{ tag: t.definition(t.propertyName), color: "#9cdcfe" },
		{ tag: t.attributeName, color: "#9cdcfe" },
		{ tag: t.attributeValue, color: "#ce9178" },
		{ tag: t.typeName, color: "#4ec9b0" },
		{ tag: t.className, color: "#4ec9b0" },
		{ tag: t.namespace, color: "#4ec9b0" },
		{ tag: t.standard(t.typeName), color: "#4ec9b0" },
		// JSX/HTML tag names are Dark+'s element blue, distinct from keyword blue.
		{ tag: t.tagName, color: "#569cd6" },
		{ tag: t.angleBracket, color: "#808080" },
		{ tag: t.constant(t.variableName), color: "#4fc1ff" },
		{ tag: t.labelName, color: "#c8c8c8" },
		{ tag: t.macroName, color: "#c586c0" },
		{ tag: t.operator, color: "#d4d4d4" },
		{ tag: t.punctuation, color: "#d4d4d4" },
		{ tag: t.separator, color: "#d4d4d4" },
		{ tag: t.bracket, color: "#d4d4d4" },
		{ tag: t.invalid, color: "#f44747" },
		// Markdown, which the pane opens as often as code.
		{ tag: t.heading, color: "#569cd6", fontWeight: "bold" },
		{ tag: t.link, color: "#3794ff", textDecoration: "underline" },
		{ tag: t.emphasis, fontStyle: "italic" },
		{ tag: t.strong, fontWeight: "bold" },
		{ tag: t.strikethrough, textDecoration: "line-through" },
	]);
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
	const desc = LanguageDescription.matchFilename(languages, path.split("/").pop() ?? path);
	if (!desc) return [];
	return [await desc.load()];
}
