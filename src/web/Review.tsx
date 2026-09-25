/**
 * Review.tsx — the agent-edit review pane.
 *
 * ONE component owns the CodeMirror `EditorView`, deliberately. There is no
 * `openFile`/`applyPatch` indirection layer: an interface with one
 * implementation would have to re-expose every decoration and transaction this
 * pane needs, and the inline accept/reject UI is exactly what leaks through a
 * generic wrapper first. The seam that actually has to survive an editor swap
 * is the HUNK FORMAT, which is plain data in shared/hunks.ts and knows nothing
 * about CodeMirror.
 *
 * What this pane is NOT: an approval queue. pi's edit tool writes during
 * execution and this server installs no `tool_call` gate, so every hunk here
 * is already on disk. Accepting records a decision and changes no bytes;
 * rejecting is the action that writes, putting the old text back. The merge
 * view is therefore oriented "what it was" → "what it is", not "what it is" →
 * "what it would be".
 *
 * The FILE LIST comes from git, not from the session's hunks. Hunks only
 * exist for edits this server process watched a tool make, so a pane driven
 * by them shows nothing after a restart, nothing from another session's tab,
 * and nothing you typed yourself — while the commit button, counting `git
 * status`, cheerfully says 11. Same source for both now. Hunks still decorate
 * the file they belong to, because keep/revert is a per-hunk decision and git
 * has no opinion about who wrote a line.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, FileCode } from "@phosphor-icons/react";
import type { EditorView } from "@codemirror/view";
import type { Hunk, HunkState } from "../shared/hunks.js";
import { fitHunk } from "../shared/hunks.js";
import { darkPlus, languageFor, loadCodeMirror } from "./codemirror.js";
import { Button, PanelHeader } from "./ui.js";

/** `/home/me/proj/src/web/App.tsx` → `src/web/App.tsx` when it is under `cwd`. */
function shortPath(path: string, cwd: string): string {
	return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

async function getJson<T>(url: string): Promise<T> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `${r.status}`);
	return (await r.json()) as T;
}

/** One working-tree change. Mirrors GitFileDiff in src/server/git.ts. */
interface FileChange {
	path: string;
	status: string;
	before: string;
	after: string;
	skipped?: string;
}

/**
 * One file's hunks, rendered as a unified merge view.
 *
 * `unifiedMergeView` rather than the side-by-side `MergeView`: one editable
 * document with inline chunks is both closer to the review UI this needs and
 * the only one of the two that survives a phone screen, which is where
 * checking on a running agent actually happens.
 *
 * The "original" side is the file as HEAD has it — handed over by git rather
 * than reconstructed by undoing hunks, which could only ever reach back to
 * the start of this session.
 */
function FileDiff({ path, before, after }: { path: string; before: string; after: string }) {
	const host = useRef<HTMLDivElement | null>(null);
	const view = useRef<EditorView | null>(null);

	useEffect(() => {
		const node = host.current;
		if (!node) return;
		let live = true;

		void Promise.all([loadCodeMirror(), languageFor(path)]).then(([cm, lang]) => {
			if (!live || !host.current) return;
			view.current = new cm.EditorView({
				parent: host.current,
				state: cm.EditorState.create({
					doc: after,
					extensions: [
						/*
						 * Read-only, and that is not a simplification. Editing here
						 * would put a third writer on the file — the agent, the
						 * user's own editor, and this pane — with no way to
						 * reconcile them, and the accept/reject decision is the
						 * only write this pane is meant to make.
						 */
						cm.EditorView.editable.of(false),
						cm.EditorState.readOnly.of(true),
						cm.EditorView.lineWrapping,
						cm.lineNumbers(),
						cm.unifiedMergeView({ original: before, mergeControls: false }),
						// Highlighting is best-effort: a language this does not
						// cover still diffs, just without colour.
						...lang,
						/*
						 * The stock highlighter, not a CodeMirror theme. This app
						 * paints everything from its own CSS variables (see
						 * index.css), so a bundled theme would be the one panel
						 * ignoring the palette — the mistake Terminal.tsx documents
						 * having already made once with xterm.
						 */
						cm.syntaxHighlighting(darkPlus(cm), { fallback: true }),
					],
				}),
			});
		});

		return () => {
			live = false;
			view.current?.destroy();
			view.current = null;
		};
		// Rebuilt when either side's text changes: a merge view's `original` is
		// fixed at construction, so there is nothing to reconfigure in place.
	}, [path, before, after]);

	return <div ref={host} className="cm-review overflow-auto text-body" />;
}

/**
 * One hunk's row: what it did, and the two decisions.
 *
 * `stale` and `missing` are surfaced rather than hidden, because the honest
 * answer to "this text is not where the agent left it" is to say so and refuse
 * the revert — a forced write would silently clobber whatever replaced it.
 */
function HunkRow({
	hunk,
	current,
	busy,
	onDecide,
}: {
	hunk: Hunk;
	current: string | null;
	busy: boolean;
	onDecide: (state: HunkState) => void;
}) {
	const fit = current === null ? null : fitHunk(hunk, current);
	const gone = fit?.fit === "missing";
	const ambiguous = fit?.fit === "ambiguous";
	const added = hunk.newText.split("\n").length;
	const removed = hunk.oldText.split("\n").length;

	return (
		<div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-ui">
			<span className="font-mono text-meta text-neutral-500">
				L{hunk.anchor.line + 1}
			</span>
			<span className="font-mono text-meta">
				{hunk.oldText !== "" && <span className="text-red-400">-{removed}</span>}
				{hunk.oldText !== "" && hunk.newText !== "" && " "}
				{hunk.newText !== "" && <span className="text-green-400">+{added}</span>}
			</span>

			{gone ? (
				<span className="text-meta text-amber-500">
					not in the file any more — nothing to revert
				</span>
			) : ambiguous ? (
				<span className="text-meta text-amber-500">
					appears {fit.count}× — reverting the nearest
				</span>
			) : null}

			<div className="ml-auto flex items-center gap-1">
				{hunk.state === "pending" ? (
					<>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => onDecide("accepted")}
						>
							<span className="flex items-center gap-1 text-green-400">
								<Check size={12} weight="bold" />
								Keep
							</span>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							// A hunk whose text is gone cannot be reverted, and
							// offering the button would promise a write that the
							// server is right to refuse.
							disabled={busy || gone}
							onClick={() => onDecide("rejected")}
						>
							<span className="flex items-center gap-1 text-red-400">
								<ArrowCounterClockwise size={12} weight="bold" />
								Revert
							</span>
						</Button>
					</>
				) : (
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => onDecide("pending")}
					>
						<span className={hunk.state === "accepted" ? "text-green-400" : "text-neutral-500"}>
							{hunk.state === "accepted" ? "Kept" : "Reverted"} · undo
						</span>
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * The pane: every uncommitted change in the project.
 *
 * Hunks come from the snapshot rather than from an event stream of their own,
 * so a reload mid-review shows exactly what was on screen before it — the
 * decisions live on the server, keyed by pi's own tool call ids, and survive
 * a remount, a tab switch and a refresh. The FILES come from git, so a file
 * whose hunks this process never saw still shows up with a diff.
 */
export function Review({
	sessionId,
	cwd,
	hunks,
	onClose,
	onChanged,
}: {
	sessionId: string;
	cwd: string;
	hunks: Hunk[];
	onClose: () => void;
	/** A revert wrote to disk; the snapshot's hunk states are now out of date. */
	onChanged: () => void;
}) {
	/** Working-tree changes, straight from git. One request, not one per file. */
	const [files, setFiles] = useState<FileChange[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		try {
			const r = await getJson<{ files: FileChange[] }>(
				`/api/git/diff?cwd=${encodeURIComponent(cwd)}`,
			);
			setFiles(r.files);
			setError(null);
		} catch (err) {
			setFiles([]);
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [cwd]);

	useEffect(() => {
		void reload();
	}, [reload]);

	// A hunk decided elsewhere (or an agent still writing) changed the tree;
	// the snapshot's hunk list is the cheapest signal that it did.
	useEffect(() => {
		void reload();
	}, [hunks, reload]);

	const decide = async (hunk: Hunk, state: HunkState) => {
		setBusy(true);
		setError(null);
		try {
			const r = await fetch(`/api/sessions/${sessionId}/hunks/${encodeURIComponent(hunk.id)}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ state }),
			});
			if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `${r.status}`);
			// Re-read from disk rather than patching local state: a revert
			// changed the file, and every other hunk in it has just moved.
			await reload();
			onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const pending = hunks.filter((h) => h.state === "pending").length;
	const list = files ?? [];

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
			<PanelHeader onClose={onClose} closeLabel="Close review">
				<FileCode size={16} className="text-neutral-400" />
				<span className="text-ui text-neutral-300">
					Changes{pending > 0 && <span className="text-amber-400"> · {pending} to review</span>}
				</span>
			</PanelHeader>

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-ui text-red-300">
					{error}
				</div>
			)}

			{files === null ? (
				<p className="p-4 text-ui text-neutral-500">Reading the working tree…</p>
			) : list.length === 0 ? (
				<p className="p-4 text-ui text-neutral-500">
					Nothing changed yet. Uncommitted edits — the agent's or your own — show up here.
				</p>
			) : (
				<div className="min-h-0 flex-1 overflow-auto">
					{list.map((file) => {
						const mine = hunks.filter((h) => h.path === file.path);
						return (
							<div key={file.path} className="border-b border-neutral-800">
								<div className="sticky top-0 z-10 bg-neutral-900 px-3 py-1.5 font-mono text-meta text-neutral-400">
									{shortPath(file.path, cwd)}
									<span className="ml-2 text-neutral-600">{file.status.trim() || "M"}</span>
									{file.skipped && <span className="ml-2 text-amber-500">{file.skipped}</span>}
								</div>
								{mine.map((h) => (
									<HunkRow
										key={h.id}
										hunk={h}
										current={file.after}
										busy={busy}
										onDecide={(state) => void decide(h, state)}
									/>
								))}
								{!file.skipped && (
									<FileDiff path={file.path} before={file.before} after={file.after} />
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
