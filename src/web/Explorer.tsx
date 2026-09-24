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

/*
 * Directory listings, kept for the life of the page.
 *
 * Without this every mount (panel reopen, project switch) starts each node
 * empty, and the restored tree unfolds one round trip per depth level. With
 * it a node renders its last known listing immediately and revalidates in the
 * background. `inflight` dedupes the prefetch in Explorer against a node's own
 * fetch for the same directory.
 */
const listings = new Map<string, PiwFileEntry[]>();
const inflight = new Map<string, Promise<PiwFileEntry[]>>();

function listDir(path: string): Promise<PiwFileEntry[]> {
	let p = inflight.get(path);
	if (!p) {
		p = getJson<{ entries: PiwFileEntry[] }>(`/api/files?path=${encodeURIComponent(path)}`)
			.then((r) => {
				listings.set(path, r.entries);
				return r.entries;
			})
			.finally(() => inflight.delete(path));
		inflight.set(path, p);
	}
	return p;
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
	const [children, setChildren] = useState<PiwFileEntry[] | null>(
		() => listings.get(entry.path) ?? null,
	);
	/** Revalidated once per mount, even when the cache already had it. */
	const [fetched, setFetched] = useState(false);
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
	 * Children are fetched the first time the node is open in this mount,
	 * which covers both the click and the restore — a restored directory
	 * mounts already open and has to fetch without anyone having clicked it.
	 * A cached listing shows meanwhile, so the restore is instant.
	 *
	 * Once per mount, then kept: collapsing is a display state, and
	 * re-fetching a directory being toggled open and shut would be a request
	 * per click for a listing that has almost certainly not changed.
	 */
	useEffect(() => {
		if (!open || fetched) return;
		let live = true;
		void listDir(entry.path)
			.then((entries) => {
				if (live) setChildren(entries);
			})
			// An unreadable directory collapses to empty rather than breaking the
			// tree: a permissions error on one folder should not cost the panel.
			.catch(() => {
				if (live) setChildren((c) => c ?? []);
			})
			.finally(() => {
				if (live) setFetched(true);
			});
		return () => {
			live = false;
		};
	}, [open, fetched, entry.path]);

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
	children,
}: {
	cwd: string;
	/** Rendered under the header: the project picker. */
	children?: React.ReactNode;
	/** The file showing in the active tab, highlighted in the tree. */
	openPath: string | null;
	/** Open this file in a tab. */
	onOpen: (path: string) => void;
	onClose: () => void;
}) {
	const [roots, setRoots] = useState<PiwFileEntry[]>(() => listings.get(cwd) ?? []);
	const [error, setError] = useState<string | null>(null);
	/*
	 * The expanded directories, restored per project. App keys this panel on
	 * `cwd`, so a project switch remounts it and the lazy initialisers (this,
	 * `roots`, every node's children) read the new project's state on the
	 * first render, with no frame of the previous project's tree.
	 */
	const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(readExplorerOpen(cwd)));

	// Fetch every remembered open directory at once, so a cold restore is one
	// round trip instead of one per depth level. Nodes pick these up through
	// listDir's in-flight dedupe. Errors are the node's to handle.
	useEffect(() => {
		for (const p of readExplorerOpen(cwd)) listDir(p).catch(() => {});
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
		let live = true;
		void listDir(cwd)
			.then((entries) => {
				if (!live) return;
				setRoots(entries);
				setError(null);
			})
			.catch((err: unknown) => {
				if (live) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			live = false;
		};
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
			{children}

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
