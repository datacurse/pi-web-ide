/**
 * Explorer.tsx — the file tree, as a rail panel.
 *
 * Only the tree. Opening a file does not open an editor here: it adds a tab to
 * the one strip the chat sessions live in, the way VS Code's explorer does,
 * and the tab renders FileEditor. That split is the whole point — the tree is
 * a place you browse from, not a container that owns your open files, so
 * closing this panel must not close what you opened.
 */

import { useCallback, useEffect, useState } from "react";
import { CaretDown, CaretRight, X } from "@phosphor-icons/react";
import type { PiwFileEntry } from "../shared/types.js";
import { FileGlyph, FolderGlyph } from "./fileIcon.js";
import { readExplorerOpen, writeExplorerOpen } from "./prefs.js";

async function getJson<T>(url: string): Promise<T> {
	const r = await fetch(url);
	if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `${r.status}`);
	return (await r.json()) as T;
}

/**
 * One expandable directory.
 *
 * Children are fetched on first expand and then kept: collapsing is a display
 * state, and re-fetching a directory the user is toggling open and shut would
 * be a request per click for a listing that has almost certainly not changed.
 */
function TreeDir({
	entry,
	depth,
	openPath,
	onOpen,
	openDirs,
	onToggle,
}: {
	entry: PiwFileEntry;
	depth: number;
	openPath: string | null;
	onOpen: (path: string) => void;
	/** Every expanded directory, by absolute path. Owned by Explorer. */
	openDirs: Set<string>;
	onToggle: (path: string) => void;
}) {
	const [children, setChildren] = useState<PiwFileEntry[] | null>(null);
	/*
	 * Expansion is the PANEL's state, not this node's.
	 *
	 * Held locally it could not be restored: a node only exists once its parent
	 * has been expanded and its listing has arrived, so there is no moment at
	 * which anything could hand it back a remembered flag. Reading it from a
	 * set the panel owns means a node knows whether it is open the instant it
	 * mounts, at any depth.
	 */
	const open = openDirs.has(entry.path);

	/*
	 * Children are fetched when the node is open and has none, which covers
	 * both the click and the restore — a restored directory mounts already
	 * open and has to fetch without anyone having clicked it.
	 *
	 * Fetched once and then kept: collapsing is a display state, and
	 * re-fetching a directory being toggled open and shut would be a request
	 * per click for a listing that has almost certainly not changed.
	 */
	useEffect(() => {
		if (!open || children !== null) return;
		let live = true;
		void getJson<{ entries: PiwFileEntry[] }>(
			`/api/files?path=${encodeURIComponent(entry.path)}`,
		)
			.then((r) => {
				if (live) setChildren(r.entries);
			})
			// An unreadable directory collapses to empty rather than breaking the
			// tree: a permissions error on one folder should not cost the panel.
			.catch(() => {
				if (live) setChildren([]);
			});
		return () => {
			live = false;
		};
	}, [open, children, entry.path]);

	return (
		<>
			<button
				type="button"
				onClick={() => onToggle(entry.path)}
				aria-expanded={open}
				style={{ paddingLeft: `${depth * 12 + 4}px` }}
				// No focus ring: the tree is a wall of rows and the browser's default
				// box around one is loud. Keyboard focus still shows, as the same
				// highlight hover uses.
				className={`flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none ${
					entry.hidden ? "text-neutral-500" : "text-neutral-300"
				}`}
			>
				{open ? (
					<CaretDown size={10} aria-hidden className="shrink-0 text-neutral-500" />
				) : (
					<CaretRight size={10} aria-hidden className="shrink-0 text-neutral-500" />
				)}
				<FolderGlyph name={entry.name} open={open} />
				<span className="truncate">{entry.name}</span>
			</button>
			{open &&
				children?.map((child) =>
					child.dir ? (
						<TreeDir
							key={child.path}
							entry={child}
							depth={depth + 1}
							openPath={openPath}
							onOpen={onOpen}
							openDirs={openDirs}
							onToggle={onToggle}
						/>
					) : (
						<TreeFile
							key={child.path}
							entry={child}
							depth={depth + 1}
							active={child.path === openPath}
							onOpen={onOpen}
						/>
					),
				)}
		</>
	);
}

function TreeFile({
	entry,
	depth,
	active,
	onOpen,
}: {
	entry: PiwFileEntry;
	depth: number;
	active: boolean;
	onOpen: (path: string) => void;
}) {
	// Flattened out of the className: the selected row wins over the dimming a
	// dotfile gets, and nesting that as a ternary inside a template literal is
	// the version nobody can read at a glance.
	let tone = "text-neutral-300";
	if (active) tone = "bg-neutral-800 text-amber-400";
	else if (entry.hidden) tone = "text-neutral-500";

	return (
		<button
			type="button"
			onClick={() => onOpen(entry.path)}
			// +20 lines a file's name up with a sibling directory's, whose caret
			// and folder icon sit to the left of where its name begins.
			style={{ paddingLeft: `${depth * 12 + 20}px` }}
			className={`flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none ${tone}`}
		>
			<FileGlyph name={entry.name} />
			<span className="truncate">{entry.name}</span>
		</button>
	);
}

export function Explorer({
	cwd,
	openPath,
	onOpen,
	onClose,
}: {
	cwd: string;
	/** The file showing in the active tab, highlighted in the tree. */
	openPath: string | null;
	/** Open this file in a tab. */
	onOpen: (path: string) => void;
	onClose: () => void;
}) {
	const [roots, setRoots] = useState<PiwFileEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	/*
	 * The expanded directories, restored per project.
	 *
	 * Keyed off `cwd` via the lazy initialiser AND the effect below, because
	 * this panel is not remounted on a project switch — without the effect it
	 * would keep showing the previous project's expansions against the new
	 * project's tree, where none of those paths exist.
	 */
	const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(readExplorerOpen(cwd)));

	useEffect(() => {
		setOpenDirs(new Set(readExplorerOpen(cwd)));
	}, [cwd]);

	const toggleDir = useCallback(
		(path: string) => {
			setOpenDirs((prev) => {
				const next = new Set(prev);
				if (!next.delete(path)) next.add(path);
				// Written here rather than in an effect on `openDirs`: the effect
				// would also fire for the restore above, writing a project's
				// remembered set straight back over itself on every switch.
				writeExplorerOpen(cwd, [...next]);
				return next;
			});
		},
		[cwd],
	);

	useEffect(() => {
		if (!cwd) return;
		void getJson<{ entries: PiwFileEntry[] }>(`/api/files?path=${encodeURIComponent(cwd)}`)
			.then((r) => {
				setRoots(r.entries);
				setError(null);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	}, [cwd]);

	return (
		<section
			aria-label="Explorer"
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950"
		>
			<div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
				<span className="text-sm text-neutral-300">Explorer</span>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close explorer"
					className="ml-auto rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
				>
					<X size={16} />
				</button>
			</div>

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
					{error}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-auto py-1">
				{roots.map((entry) =>
					entry.dir ? (
						<TreeDir
							key={entry.path}
							entry={entry}
							depth={0}
							openPath={openPath}
							onOpen={onOpen}
							openDirs={openDirs}
							onToggle={toggleDir}
						/>
					) : (
						<TreeFile
							key={entry.path}
							entry={entry}
							depth={0}
							active={entry.path === openPath}
							onOpen={onOpen}
						/>
					),
				)}
			</div>
		</section>
	);
}
