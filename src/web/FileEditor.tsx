/**
 * FileEditor.tsx — one open file, as the body of one tab.
 *
 * ONE component owns the CodeMirror `EditorView`, deliberately. There is no
 * `openFile`/`applyPatch` indirection: an interface with one implementation
 * would have to re-expose every extension, keymap and transaction this needs,
 * and would be the first thing in the way when the editor has to do something
 * editor-shaped.
 *
 * It owns exactly one buffer, because the tab strip owns which files are open
 * — the same strip the chat sessions live in. This used to hold its own tab
 * bar and file tree; both moved out (Explorer.tsx, App's `tabs`) so that
 * closing the tree does not close your files.
 *
 * The concurrency story is the part worth reading. Three writers can touch one
 * file — the agent, this editor, and the user's own editor outside the browser
 * — and this server is the only thing that sees more than one of them. So the
 * buffer remembers the text it loaded (`base`), every save sends it, and the
 * server refuses the write if disk no longer matches. A save is never "last
 * writer wins" here; it is "writer who is still in sync wins, everyone else
 * gets told".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, FloppyDisk } from "@phosphor-icons/react";
import type { EditorView } from "@codemirror/view";
import { darkPlus, languageFor, loadCodeMirror } from "./codemirror.js";

async function getJson<T>(url: string): Promise<T> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `${r.status}`);
	return (await r.json()) as T;
}

/** `/home/me/proj/src/App.tsx` → `src/App.tsx` when it is under `cwd`. */
function shortPath(path: string, cwd: string): string {
	return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

export function FileEditor({
	path,
	cwd,
	onDirty,
}: {
	path: string;
	cwd: string;
	/**
	 * Report unsaved state upward, so the tab can show a dot.
	 *
	 * The strip is rendered by App and cannot see into this component;
	 * without this, a modified file would look identical to a saved one from
	 * the outside and could be closed silently.
	 */
	onDirty: (path: string, dirty: boolean) => void;
}) {
	/** What disk held when this buffer loaded. The optimistic-concurrency check. */
	const [base, setBase] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const host = useRef<HTMLDivElement | null>(null);
	const view = useRef<EditorView | null>(null);
	/*
	 * The saved baseline, read from inside callbacks that were created before
	 * the latest save. The listener and the save handler both need the CURRENT
	 * value, and a stale closure would compare against the wrong text.
	 */
	const baseRef = useRef<string | null>(null);
	baseRef.current = base;

	// Report upward whenever it changes, and report clean on unmount so a
	// closed tab cannot leave a dot behind in App's map.
	useEffect(() => {
		onDirty(path, dirty);
	}, [path, dirty, onDirty]);
	useEffect(() => () => onDirty(path, false), [path, onDirty]);

	/*
	 * Build the view once per PATH, not per keystroke: rebuilding on text would
	 * destroy and recreate the editor as you type, losing the cursor, the
	 * selection and the undo history.
	 */
	useEffect(() => {
		let live = true;
		setBase(null);
		setDirty(false);
		setError(null);

		void (async () => {
			try {
				const [cm, file, lang] = await Promise.all([
					loadCodeMirror(),
					getJson<{ content: string | null }>(`/api/file?path=${encodeURIComponent(path)}`),
					languageFor(path),
				]);
				if (!live || !host.current) return;

				const text = file.content ?? "";
				setBase(text);
				baseRef.current = text;

				view.current = new cm.EditorView({
					parent: host.current,
					doc: text,
					extensions: [
						cm.lineNumbers(),
						cm.foldGutter(),
						cm.history(),
						cm.drawSelection(),
						cm.highlightActiveLine(),
						cm.highlightSelectionMatches(),
						cm.bracketMatching(),
						cm.closeBrackets(),
						cm.indentOnInput(),
						cm.autocompletion(),
						cm.EditorView.lineWrapping,
						/*
						 * `indentWithTab` last: it binds Tab, which is the
						 * focus-escape key everywhere else on the page. Bound here it
						 * is scoped to a focused editor, and Escape-then-Tab still
						 * leaves the pane — trapping Tab globally would make the
						 * editor a keyboard dead end.
						 */
						cm.keymap.of([
							...cm.closeBracketsKeymap,
							...cm.defaultKeymap,
							...cm.historyKeymap,
							...cm.searchKeymap,
							...cm.completionKeymap,
							cm.indentWithTab,
						]),
						...lang,
						cm.syntaxHighlighting(darkPlus(cm), { fallback: true }),
						cm.EditorView.updateListener.of((update) => {
							if (!update.docChanged) return;
							setDirty(update.state.doc.toString() !== baseRef.current);
						}),
					],
				});
			} catch (err) {
				// A failed read or a chunk that will not load otherwise leaves an
				// empty pane and no clue why — the failure mode of a lazily loaded
				// editor that looks like a bug rather than a failed request.
				if (live) setError(err instanceof Error ? err.message : String(err));
			}
		})();

		return () => {
			live = false;
			view.current?.destroy();
			view.current = null;
		};
	}, [path]);

	const save = useCallback(async () => {
		const view_ = view.current;
		if (!view_ || base === null) return;
		const text = view_.state.doc.toString();
		setSaving(true);
		setError(null);
		try {
			const r = await fetch("/api/file", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ path, content: text, expect: base }),
			});
			if (!r.ok) {
				const body = (await r.json()) as { error?: string };
				throw new Error(
					r.status === 409
						? `${body.error ?? "conflict"} — Reload to get the newer version (your edits stay in the tab until you do).`
						: (body.error ?? `${r.status}`),
				);
			}
			// The saved text IS the new base: a second save against the old one
			// would be refused as stale by the server's own check.
			setBase(text);
			baseRef.current = text;
			setDirty(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [path, base]);

	/** Re-read from disk, discarding this buffer's edits. The conflict escape. */
	const reload = useCallback(async () => {
		setError(null);
		try {
			const r = await getJson<{ content: string | null }>(
				`/api/file?path=${encodeURIComponent(path)}`,
			);
			const text = r.content ?? "";
			setBase(text);
			baseRef.current = text;
			setDirty(false);
			// Replacing the document shows the new text without rebuilding the
			// editor, which would cost the scroll position too.
			view.current?.dispatch({
				changes: { from: 0, to: view.current.state.doc.length, insert: text },
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [path]);

	/*
	 * Ctrl/Cmd+S, scoped to this pane rather than the window: a global handler
	 * would swallow the browser's own save everywhere else in the app, and
	 * this one only means anything while an editor has focus.
	 */
	const onKeyDown = (e: React.KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "s") {
			e.preventDefault();
			void save();
		}
	};

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950" onKeyDown={onKeyDown}>
			<div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5">
				<span className="min-w-0 truncate font-mono text-xs text-neutral-400" title={path}>
					{shortPath(path, cwd)}
				</span>
				<button
					onClick={() => void save()}
					disabled={!dirty || saving}
					title="Save (Ctrl+S)"
					className="ml-auto flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
				>
					<FloppyDisk size={13} />
					Save
				</button>
				<button
					onClick={() => void reload()}
					title="Re-read from disk, discarding edits in this tab"
					className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs text-neutral-300 hover:bg-neutral-800"
				>
					<ArrowClockwise size={13} />
					Reload
				</button>
			</div>

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
					{error}
				</div>
			)}

			<div ref={host} className="cm-editor-host min-h-0 flex-1 overflow-auto text-sm" />
		</div>
	);
}
