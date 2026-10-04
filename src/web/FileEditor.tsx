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
import {
  languageFor,
  loadCodeMirror,
  syntaxStyle,
  wrapIndent,
} from "./codemirror.js";
import { Button, PanelHeader } from "./ui.js";
import { api, unwrap } from "./api.js";
import { t } from "./i18n.js";
import { revealFileLine, type FileLocation } from "./fileNavigation.js";
import { MarkdownEditor } from "./MarkdownEditor.js";

/** `/home/me/proj/src/App.tsx` → `src/App.tsx` when it is under `cwd`. */
function shortPath(path: string, cwd: string): string {
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

export function FileEditor({
  path,
  cwd,
  onDirty,
  reveal,
}: {
  path: string;
  cwd: string;
  reveal?: FileLocation;
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
  const [formatted, setFormatted] = useState(false);
  const [preview, setPreview] = useState("");
  const [previewVersion, setPreviewVersion] = useState(0);
  const isMarkdown = /\.(md|markdown|mdown|mkd)$/i.test(path);

  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  /*
   * The saved baseline, read from inside callbacks that were created before
   * the latest save. The listener and the save handler both need the CURRENT
   * value, and a stale closure would compare against the wrong text.
   */
  const baseRef = useRef<string | null>(null);
  baseRef.current = base;

  const editFormatted = useCallback((text: string) => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === text) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
    });
  }, []);

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
    setFormatted(false);
    setPreview("");

    void (async () => {
      try {
        const [cm, file, lang] = await Promise.all([
          loadCodeMirror(),
          unwrap(api.file.$get({ query: { path } })),
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
            cm.EditorView.contentAttributes.of((view) => ({
              class: view.state.selection.ranges.some((range) => !range.empty)
                ? "cm-hasSelection"
                : "",
            })),
            cm.highlightSelectionMatches(),
            cm.bracketMatching(),
            cm.closeBrackets(),
            cm.indentOnInput(),
            cm.autocompletion(),
            cm.EditorView.lineWrapping,
            wrapIndent(cm),
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
            cm.syntaxHighlighting(syntaxStyle(cm, "etk"), { fallback: true }),
            cm.EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              setDirty(update.state.doc.toString() !== baseRef.current);
            }),
          ],
        });
        const target = revealRef.current;
        if (target?.path === path)
          revealFileLine(view.current, cm, target.line);
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

  // Reveal subsequent links without rebuilding the editor or losing unsaved text/undo history.
  useEffect(() => {
    if (!reveal || reveal.path !== path || !view.current) return;
    setFormatted(false);
    let live = true;
    void loadCodeMirror().then((cm) => {
      if (live && view.current && revealRef.current === reveal)
        revealFileLine(view.current, cm, reveal.line);
    });
    return () => {
      live = false;
    };
  }, [path, reveal]);

  // Keep the same editor alive across views, preserving selection and undo.
  useEffect(() => {
    if (!formatted) view.current?.requestMeasure();
  }, [formatted]);

  const save = useCallback(async () => {
    const view_ = view.current;
    if (!view_ || base === null) return;
    const text = view_.state.doc.toString();
    setSaving(true);
    setError(null);
    try {
      const r = await api.file.$put({
        json: { path, content: text, expect: base },
      });
      if (!r.ok) {
        const body = (await r.json()) as { error?: string };
        throw new Error(
          r.status === 409
            ? t(
                "{error} — Reload to get the newer version (your edits stay in the tab until you do).",
                {
                  error: body.error ?? t("conflict"),
                },
              )
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
      const r = await unwrap(api.file.$get({ query: { path } }));
      const text = r.content ?? "";
      setPreview(text);
      setPreviewVersion((version) => version + 1);
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
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950"
      onKeyDown={onKeyDown}
    >
      <PanelHeader>
        <span
          className="min-w-0 fade-end font-mono text-meta text-neutral-400"
          title={path}
        >
          {shortPath(path, cwd)}
        </span>
        {isMarkdown && (
          <div
            className="ml-auto flex gap-1"
            role="group"
            aria-label={t("Markdown view")}
          >
            <Button
              variant={!formatted ? "subtle" : "ghost"}
              size="sm"
              aria-pressed={!formatted}
              onClick={() => setFormatted(false)}
            >
              {t("Raw")}
            </Button>
            <Button
              variant={formatted ? "subtle" : "ghost"}
              size="sm"
              aria-pressed={formatted}
              disabled={base === null}
              onClick={() => {
                if (formatted) return;
                setPreview(view.current?.state.doc.toString() ?? "");
                setFormatted(true);
              }}
            >
              {t("Formatted")}
            </Button>
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={isMarkdown ? undefined : "ml-auto"}
          onClick={() => void save()}
          disabled={!dirty || saving}
          title={t("Save (Ctrl+S)")}
        >
          <FloppyDisk size={13} />
          {t("Save")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void reload()}
          title={t("Re-read from disk, discarding edits in this tab")}
        >
          <ArrowClockwise size={13} />
          {t("Reload")}
        </Button>
      </PanelHeader>

      {error && (
        <div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-meta text-red-300">
          {error}
        </div>
      )}

      <div
        ref={host}
        className={`cm-editor-host min-h-0 flex-1 overflow-auto text-body${formatted ? " hidden" : ""}`}
      />
      {formatted && (
        <MarkdownEditor
          key={previewVersion}
          text={preview}
          onChange={editFormatted}
        />
      )}
    </div>
  );
}
