/**
 * DiffView.tsx — one file's diff, as the body of one tab.
 *
 * Lifted out of the old Changes panel, where the diff was rendered INSIDE the
 * sidebar: every changed file's two copies arrived in one response and were
 * stacked in a 300px column, which is where a diff is least readable and most
 * expensive. Here the panel lists names and a tab shows one diff at the width
 * of the editor — the arrangement VS Code has, for the same reason.
 *
 * Read-only, and that is not a simplification. Editing here would put a third
 * writer on the file (the agent, the editor tab, this pane) with no way to
 * reconcile them. The hunk decisions below are the one write, and they go
 * through the server.
 *
 * Both sides come from the server per file (`/api/git/show`), so a commit's
 * diff and the working tree's are the same component with a different `ref`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Check } from "@phosphor-icons/react";
import type { EditorView } from "@codemirror/view";
import type { Hunk, HunkState } from "../shared/hunks.js";
import { fitHunk } from "../shared/hunks.js";
import { darkPlus, languageFor, loadCodeMirror } from "./codemirror.js";
import { Button, PanelHeader } from "./ui.js";

async function getJson<T>(url: string): Promise<T> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `${r.status}`);
	return (await r.json()) as T;
}

/** `/home/me/proj/src/web/App.tsx` → `src/web/App.tsx` when it is under `cwd`. */
function shortPath(path: string, cwd: string): string {
	return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

interface FileDiff {
	path: string;
	before: string;
	after: string;
	skipped?: string;
}

/**
 * The merge view itself.
 *
 * `unifiedMergeView` rather than the side-by-side `MergeView`: one document
 * with inline chunks is both closer to a review UI and the only one of the
 * two that survives a phone screen, which is where checking on a running
 * agent actually happens.
 */
function Merge({ path, before, after }: { path: string; before: string; after: string }) {
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
						 * index.css), so a bundled theme would be the one pane
						 * ignoring the palette.
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

	return <div ref={host} className="cm-review min-h-0 flex-1 overflow-auto text-body" />;
}

/**
 * One hunk's row: what it did, and the two decisions.
 *
 * `stale` and `missing` are surfaced rather than hidden, because the honest
 * answer to "this text is not where the agent left it" is to say so and refuse
 * the revert — a forced write would silently clobber whatever replaced it.
 *
 */
export function HunkRow({
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
			<span className="font-mono text-meta text-neutral-500">L{hunk.anchor.line + 1}</span>
			<span className="font-mono text-meta">
				{hunk.oldText !== "" && <span className="text-red-400">-{removed}</span>}
				{hunk.oldText !== "" && hunk.newText !== "" && " "}
				{hunk.newText !== "" && <span className="text-green-400">+{added}</span>}
			</span>

			{gone ? (
				<span className="text-meta text-amber-500">not in the file any more — nothing to revert</span>
			) : ambiguous ? (
				<span className="text-meta text-amber-500">appears {fit.count}× — reverting the nearest</span>
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
							// offering the button would promise a write the server is
							// right to refuse.
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
 * One diff tab: a file, as of a commit or as it stands in the working tree.
 *
 * The hunk rows only appear for the WORKING TREE (`ref` empty), because that
 * is the only state a decision can still change — keep/revert on a committed
 * hunk would be a rewrite of history, which this is deliberately not.
 */
export function DiffView({
	path,
	refName,
	cwd,
	sessionId,
	hunks,
	onChanged,
}: {
	path: string;
	/** Commit sha, or "" for the working tree. */
	refName: string;
	cwd: string;
	/** The attached session, when there is one: hunk decisions post against it. */
	sessionId?: string;
	/** This session's hunks for THIS file. Empty for a commit's diff. */
	hunks: Hunk[];
	/** A revert wrote to disk; the snapshot's hunk states are now out of date. */
	onChanged?: () => void;
}) {
	const [file, setFile] = useState<FileDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = useCallback(async () => {
		try {
			setFile(
				await getJson<FileDiff>(
					`/api/git/show?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(refName)}`,
				),
			);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [cwd, path, refName]);

	useEffect(() => {
		void reload();
	}, [reload]);

	/*
	 * A commit's diff is immutable, so it is read once. The working tree is
	 * not: the agent is writing into it while this is open, and the hunk list
	 * changing is the cheapest signal that it did.
	 */
	useEffect(() => {
		if (refName) return;
		void reload();
	}, [hunks, refName, reload]);

	const decide = async (hunk: Hunk, state: HunkState) => {
		if (!sessionId) return;
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
			onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const mine = refName ? [] : hunks;

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
			<PanelHeader>
				<span className="min-w-0 truncate font-mono text-meta text-neutral-400" title={path}>
					{shortPath(path, cwd)}
				</span>
				<span className="shrink-0 text-meta text-neutral-500">
					{refName ? `${refName.slice(0, 7)} ↔ parent` : "HEAD ↔ working tree"}
				</span>
			</PanelHeader>

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-meta text-red-300">
					{error}
				</div>
			)}

			{mine.map((h) => (
				<HunkRow
					key={h.id}
					hunk={h}
					current={file?.after ?? null}
					busy={busy}
					onDecide={(state) => void decide(h, state)}
				/>
			))}

			{file === null ? (
				<p className="p-4 text-ui text-neutral-500">Reading…</p>
			) : file.skipped ? (
				<p className="p-4 text-ui text-amber-500">{file.skipped}</p>
			) : (
				<Merge path={path} before={file.before} after={file.after} />
			)}
		</div>
	);
}
