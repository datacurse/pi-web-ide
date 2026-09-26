/**
 * Explorer.tsx — the file tree, as a rail panel.
 *
 * Only the tree. Opening a file does not open an editor here: it adds a tab to
 * the one strip the chat sessions live in, the way VS Code's explorer does,
 * and the tab renders FileEditor. That split is the whole point — the tree is
 * a place you browse from, not a container that owns your open files, so
 * closing this panel must not close what you opened.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent } from "react";
import {
	ArrowClockwise,
	ArrowElbowDownRight,
	CaretDown,
	CaretRight,
	ChatText,
	Clipboard,
	Copy,
	DownloadSimple,
	File as FileIcon,
	FilePlus,
	FolderPlus,
	GitDiff,
	Path,
	PencilSimple,
	Scissors,
	SquareSplitHorizontal,
	TerminalWindow,
	Trash,
} from "@phosphor-icons/react";
import type { PiwFileEntry } from "../shared/types.js";
import { FileGlyph } from "./fileIcon.js";
import { readExplorerOpen, writeExplorerOpen } from "./prefs.js";
import { ContextMenu, IconButton, ListRow, MenuItem, MenuSeparator, PanelHeader, inputClass } from "./ui.js";

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

/** Right-click on a row: open the panel's menu for that entry. */
type RowMenu = (entry: PiwFileEntry, e: MouseEvent<HTMLButtonElement>) => void;

/** `path` relative to the project, which is how prompts and shells name it. */
function relativePath(cwd: string, path: string): string {
	if (path === cwd) return ".";
	return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** The folder holding `path`. */
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));

async function postJson<T>(url: string, body: unknown): Promise<T> {
	const r = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const out = (await r.json().catch(() => ({}))) as T & { error?: string };
	if (!r.ok) throw new Error(out.error ?? `${r.status}`);
	return out;
}

/** A name being typed in the tree: a new entry inside `parent`, or a rename. */
type NameEdit =
	| { kind: "file" | "folder"; parent: string }
	| { kind: "rename"; path: string; name: string; dir: boolean };

/**
 * The edit in progress, read by whichever row it belongs to. Context rather
 * than props because it is needed at one row at any depth, and threading it
 * through every node would re-render the whole tree per keystroke.
 */
const EditContext = createContext<{ edit: NameEdit | null; done: (name: string | null) => void }>({
	edit: null,
	done: () => {},
});

/**
 * The inline name field, in the row's own place and indent. Enter or leaving
 * the field commits; Escape cancels. A rename selects the name without its
 * extension, as VS Code does, since that is the part usually changed.
 */
function NameRow({ depth, dir, initial }: { depth: number; dir: boolean; initial: string }) {
	const { done } = useContext(EditContext);
	const [value, setValue] = useState(initial);
	const field = useRef<HTMLInputElement>(null);
	const finished = useRef(false);
	const finish = (name: string | null) => {
		if (finished.current) return;
		finished.current = true;
		done(name?.trim() || null);
	};
	useEffect(() => {
		const dot = initial.lastIndexOf(".");
		field.current?.setSelectionRange(0, dot > 0 ? dot : initial.length);
	}, [initial]);
	return (
		<div className="flex items-center gap-1.5 py-0.5 pr-3" style={{ paddingLeft: `${depth * 12 + 4}px` }}>
			<span className="flex w-4 shrink-0 justify-center text-neutral-500" aria-hidden>
				{dir ? <CaretRight size={14} /> : <FileGlyph name={value} />}
			</span>
			<input
				ref={field}
				autoFocus
				aria-label={dir ? "Folder name" : "File name"}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") finish(value);
					else if (e.key === "Escape") finish(null);
				}}
				onBlur={() => finish(value)}
				className={`min-w-0 flex-1 ${inputClass.sm}`}
			/>
		</div>
	);
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
	onMenu,
	rev,
}: {
	entry: PiwFileEntry;
	depth: number;
	openPath: string | null;
	onOpen: (path: string) => void;
	/** Every expanded directory, by absolute path. Owned by Explorer. */
	openDirs: Set<string>;
	onToggle: (path: string) => void;
	onMenu: RowMenu;
	/** Changes when the tree should be re-read from disk. */
	rev: string;
}) {
	const [children, setChildren] = useState<PiwFileEntry[] | null>(
		() => listings.get(entry.path) ?? null,
	);
	/** The `rev` last fetched at: revalidated once per mount and per refresh. */
	const [fetched, setFetched] = useState<string | null>(null);
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
		if (!open || fetched === rev) return;
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
				if (live) setFetched(rev);
			});
		return () => {
			live = false;
		};
	}, [open, fetched, rev, entry.path]);

	const { edit } = useContext(EditContext);
	const renaming = edit?.kind === "rename" && edit.path === entry.path;
	const adding = edit && edit.kind !== "rename" && edit.parent === entry.path ? edit : null;

	return (
		<>
			{renaming ? (
				<NameRow depth={depth} dir initial={entry.name} />
			) : (
				<ListRow
					onClick={() => onToggle(entry.path)}
					data-path={entry.path}
					onContextMenu={(e) => onMenu(entry, e)}
					muted={entry.hidden}
					size="body"
					aria-expanded={open}
					style={{ paddingLeft: `${depth * 12 + 4}px` }}
				>
					{/* A 16px slot, the width of a file's icon, so names line up the way
					    VS Code's do: Seti has no folder icons, the chevron stands in. */}
					<span className="flex w-4 shrink-0 justify-center text-neutral-500" aria-hidden>
						{open ? <CaretDown size={14} /> : <CaretRight size={14} />}
					</span>
					<span className="truncate">{entry.name}</span>
				</ListRow>
			)}
			{open && adding && <NameRow depth={depth + 1} dir={adding.kind === "folder"} initial="" />}
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
							onMenu={onMenu}
							rev={rev}
						/>
					) : (
						<TreeFile
							key={child.path}
							entry={child}
							depth={depth + 1}
							active={child.path === openPath}
							onOpen={onOpen}
							onMenu={onMenu}
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
	onMenu,
}: {
	entry: PiwFileEntry;
	depth: number;
	active: boolean;
	onOpen: (path: string) => void;
	onMenu: RowMenu;
}) {
	const { edit } = useContext(EditContext);
	if (edit?.kind === "rename" && edit.path === entry.path) {
		return <NameRow depth={depth} dir={false} initial={entry.name} />;
	}
	return (
		<ListRow
			onClick={() => onOpen(entry.path)}
			data-path={entry.path}
			onContextMenu={(e) => onMenu(entry, e)}
			selected={active}
			muted={entry.hidden}
			size="body"
			// Same indent as a sibling directory: the icon takes the chevron's slot.
			style={{ paddingLeft: `${depth * 12 + 4}px` }}
		>
			<FileGlyph name={entry.name} />
			<span className="truncate">{entry.name}</span>
		</ListRow>
	);
}

export function Explorer({
	cwd,
	openPath,
	onOpen,
	onOpenSide,
	onOpenDiff,
	onOpenTerminal,
	onAddToChat,
	onPathChange,
	hasUnsaved,
	reveal,
	onRevealed,
	onClose,
	revision,
	children,
}: {
	cwd: string;
	/** Changes when something may have touched the tree; re-reads it. */
	revision: number;
	/** Rendered under the header: the project picker. */
	children?: React.ReactNode;
	/** The file showing in the active tab, highlighted in the tree. */
	openPath: string | null;
	/** Open this file in a tab. */
	onOpen: (path: string) => void;
	/** Open this file in the second column, splitting if needed. */
	onOpenSide: (path: string) => void;
	/** Open a diff tab: `ref` empty is the working tree, `path` project-relative. */
	onOpenDiff: (ref: string, path: string) => void;
	/** A new terminal starting in this directory; absent with no project. */
	onOpenTerminal?: (dir: string) => Promise<void>;
	/** Append text to the open session's composer; absent when none is open. */
	onAddToChat?: (text: string) => void;
	/** A path was renamed to `to`, or deleted (null): open tabs follow. */
	onPathChange: (from: string, to: string | null) => void;
	/** Unsaved edits at or under a path; renaming or deleting it is refused. */
	hasUnsaved: (path: string) => boolean;
	/** A file to expand down to and scroll into view; `onRevealed` clears it. */
	reveal?: string | null;
	onRevealed?: () => void;
	onClose: () => void;
}) {
	const [roots, setRoots] = useState<PiwFileEntry[]>(() => listings.get(cwd) ?? []);
	const [error, setError] = useState<string | null>(null);
	/** Bumped by the refresh button. */
	const [manual, setManual] = useState(0);
	const rev = `${revision}:${manual}`;
	/*
	 * The expanded directories, restored per project. App keys this panel on
	 * `cwd`, so a project switch remounts it and the lazy initialisers (this,
	 * `roots`, every node's children) read the new project's state on the
	 * first render, with no frame of the previous project's tree.
	 */
	const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(readExplorerOpen(cwd)));
	/** `root`: opened on the empty area below the rows, acting on the project itself. */
	const [menu, setMenu] = useState<{ entry: PiwFileEntry; x: number; y: number; root?: boolean } | null>(
		null,
	);
	const [edit, setEdit] = useState<NameEdit | null>(null);
	/** Cut or copied, waiting for Paste. Cut is a move, so it is used up by one paste. */
	const [clip, setClip] = useState<{ path: string; cut: boolean } | null>(null);
	/** Project-relative paths git reports as changed, read when a menu opens. */
	const [changed, setChanged] = useState<Set<string>>(() => new Set());

	const openMenu = useCallback<RowMenu>((entry, e) => {
		e.preventDefault();
		// Not a repo, or git failed: no "Open Changes", nothing else lost.
		if (!entry.dir) {
			void getJson<{ files: Array<{ path: string }> }>(
				`/api/git/changes?cwd=${encodeURIComponent(cwd)}`,
			)
				.then((r) => setChanged(new Set(r.files.map((f) => f.path))))
				.catch(() => setChanged(new Set()));
		}
		// A keyboard-raised menu reports (0,0); anchor it to the row instead.
		const box = e.currentTarget.getBoundingClientRect();
		setMenu({ entry, x: e.clientX || box.left + 16, y: e.clientY || box.bottom });
	}, [cwd]);

	/** Run a menu action, closing the menu first. */
	const act = (fn: () => void | Promise<void>) => () => {
		setMenu(null);
		void Promise.resolve()
			.then(fn)
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

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

	const tree = useRef<HTMLDivElement>(null);

	/*
	 * Reveal: open every folder between the project and the file, then wait
	 * for its row. The rows arrive as each folder's listing loads, so this
	 * watches the tree for the row rather than guessing how long that takes.
	 */
	useEffect(() => {
		const el = tree.current;
		if (!reveal || !el) return;
		const done = () => onRevealed?.();
		if (!reveal.startsWith(`${cwd}/`)) return done();
		const dirs: string[] = [];
		for (let p = parentOf(reveal); p.length > cwd.length; p = parentOf(p)) dirs.push(p);
		setOpenDirs((prev) => {
			if (dirs.every((d) => prev.has(d))) return prev;
			const next = new Set([...prev, ...dirs]);
			writeExplorerOpen(cwd, [...next]);
			return next;
		});
		const find = () => el.querySelector<HTMLElement>(`[data-path="${CSS.escape(reveal)}"]`);
		const show = (row: HTMLElement) => {
			row.scrollIntoView({ block: "center" });
			row.focus({ preventScroll: true });
			done();
		};
		const now = find();
		if (now) return show(now);
		const watch = new MutationObserver(() => {
			const row = find();
			if (row) show(row);
		});
		watch.observe(el, { childList: true, subtree: true });
		// A file the tree skips (under node_modules, say) never gets a row.
		const giveUp = setTimeout(done, 5000);
		return () => {
			watch.disconnect();
			clearTimeout(giveUp);
		};
		// `onRevealed` is a fresh closure each render; `reveal` is the trigger.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [reveal, cwd]);

	const refresh = () => setManual((n) => n + 1);
	const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
	const guard = (path: string) => {
		if (hasUnsaved(path)) throw new Error("Save or discard the unsaved edits under it first.");
	};

	/** Start a new file or folder in `parent`, opening it so the field shows. */
	const startNew = (kind: "file" | "folder", parent: string) => {
		if (parent !== cwd && !openDirs.has(parent)) toggleDir(parent);
		setEdit({ kind, parent });
	};

	/** The inline field finished: create or rename, or nothing on cancel. */
	const finishEdit = (name: string | null) => {
		const current = edit;
		setEdit(null);
		if (!current || !name) return;
		void (async () => {
			if (current.kind === "rename") {
				if (name === current.name) return;
				const to = `${parentOf(current.path)}/${name}`;
				await postJson("/api/files/move", { from: current.path, to });
				onPathChange(current.path, to);
			} else {
				const r = await postJson<{ path: string }>("/api/files/create", {
					path: `${current.parent}/${name}`,
					dir: current.kind === "folder",
				});
				if (current.kind === "file") onOpen(r.path);
			}
			refresh();
		})().catch(fail);
	};

	/** Paste the clipboard into `dir`: a cut moves (and is used up), a copy copies. */
	const paste = async (dir: string) => {
		if (!clip) return;
		if (clip.cut) {
			const to = `${dir}/${clip.path.slice(clip.path.lastIndexOf("/") + 1)}`;
			if (to !== clip.path) {
				guard(clip.path);
				await postJson("/api/files/move", { from: clip.path, to });
				onPathChange(clip.path, to);
			}
			setClip(null);
		} else {
			await postJson("/api/files/copy", { from: clip.path, toDir: dir });
		}
		refresh();
	};

	const trash = async (entry: PiwFileEntry) => {
		guard(entry.path);
		if (!window.confirm(`Move "${entry.name}" to the Trash?`)) return;
		await postJson("/api/files/trash", { path: entry.path });
		onPathChange(entry.path, null);
		if (clip && (clip.path === entry.path || clip.path.startsWith(`${entry.path}/`))) setClip(null);
		refresh();
	};

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
	}, [cwd, rev]);

	return (
		<section
			aria-label="Explorer"
			className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950"
		>
			<PanelHeader title="Explorer" onClose={onClose}>
				<IconButton size="sm" className="ml-auto" onClick={refresh} label="Refresh explorer">
					<ArrowClockwise size={16} />
				</IconButton>
			</PanelHeader>
			{children}

			{error && (
				<div className="border-b border-red-900 bg-red-950/40 px-3 py-2 text-meta text-red-300">
					{error}
				</div>
			)}

			<EditContext.Provider value={{ edit, done: finishEdit }}>
				<div
					ref={tree}
					className="min-h-0 flex-1 overflow-auto py-1"
					// The empty space below the rows: a menu for the project itself.
					onContextMenu={(e) => {
						if (e.target !== e.currentTarget) return;
						e.preventDefault();
						const name = cwd.slice(cwd.lastIndexOf("/") + 1);
						setMenu({ entry: { name, path: cwd, dir: true, hidden: false }, x: e.clientX, y: e.clientY, root: true });
					}}
				>
					{edit && edit.kind !== "rename" && edit.parent === cwd && (
						<NameRow depth={0} dir={edit.kind === "folder"} initial="" />
					)}
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
								onMenu={openMenu}
								rev={rev}
							/>
						) : (
							<TreeFile
								key={entry.path}
								entry={entry}
								depth={0}
								active={entry.path === openPath}
								onOpen={onOpen}
								onMenu={openMenu}
							/>
						),
					)}
				</div>
			</EditContext.Provider>

			{menu && (() => {
				const m = menu.entry;
				const dir = m.dir ? m.path : parentOf(m.path);
				return (
					<ContextMenu x={menu.x} y={menu.y} label={m.name} onClose={() => setMenu(null)}>
						{m.dir ? (
							<>
								<MenuItem icon={<FilePlus size={16} />} role="menuitem" autoFocus onClick={act(() => startNew("file", m.path))}>
									New File…
								</MenuItem>
								<MenuItem icon={<FolderPlus size={16} />} role="menuitem" onClick={act(() => startNew("folder", m.path))}>
									New Folder…
								</MenuItem>
							</>
						) : (
							<>
								<MenuItem icon={<FileIcon size={16} />} role="menuitem" autoFocus onClick={act(() => onOpen(m.path))}>
									Open
								</MenuItem>
								<MenuItem icon={<SquareSplitHorizontal size={16} />} role="menuitem" onClick={act(() => onOpenSide(m.path))}>
									Open to the Side
								</MenuItem>
								{changed.has(relativePath(cwd, m.path)) && (
									<MenuItem icon={<GitDiff size={16} />} role="menuitem" onClick={act(() => onOpenDiff("", relativePath(cwd, m.path)))}>
										Open Changes
									</MenuItem>
								)}
							</>
						)}
						<MenuSeparator />
						{!menu.root && (
							<MenuItem icon={<ChatText size={16} />}
								role="menuitem"
								disabled={!onAddToChat}
								title={onAddToChat ? undefined : "Open a session first"}
								onClick={act(() => onAddToChat?.(relativePath(cwd, m.path)))}
							>
								Add to Chat
							</MenuItem>
						)}
						<MenuItem icon={<TerminalWindow size={16} />} role="menuitem" disabled={!onOpenTerminal} onClick={act(() => onOpenTerminal?.(dir))}>
							Open in Terminal
						</MenuItem>
						{!m.dir && (
							<MenuItem icon={<DownloadSimple size={16} />}
								role="menuitem"
								onClick={act(() => {
									const a = document.createElement("a");
									a.href = `/api/download?path=${encodeURIComponent(m.path)}`;
									a.download = m.name;
									a.click();
								})}
							>
								Download
							</MenuItem>
						)}
						<MenuSeparator />
						<MenuItem icon={<Path size={16} />} role="menuitem" onClick={act(() => navigator.clipboard.writeText(m.path))}>
							Copy Path
						</MenuItem>
						{!menu.root && (
							<MenuItem icon={<ArrowElbowDownRight size={16} />}
								role="menuitem"
								onClick={act(() => navigator.clipboard.writeText(relativePath(cwd, m.path)))}
							>
								Copy Relative Path
							</MenuItem>
						)}
						<MenuSeparator />
						{!menu.root && (
							<>
								<MenuItem icon={<Scissors size={16} />} role="menuitem" onClick={act(() => setClip({ path: m.path, cut: true }))}>
									Cut
								</MenuItem>
								<MenuItem icon={<Copy size={16} />} role="menuitem" onClick={act(() => setClip({ path: m.path, cut: false }))}>
									Copy
								</MenuItem>
							</>
						)}
						<MenuItem icon={<Clipboard size={16} />}
							role="menuitem"
							disabled={!clip}
							title={clip ? `Paste ${clip.path.slice(clip.path.lastIndexOf("/") + 1)} into ${relativePath(cwd, dir)}` : undefined}
							onClick={act(() => paste(dir))}
						>
							Paste
						</MenuItem>
						{!menu.root && (
							<>
								<MenuSeparator />
								<MenuItem icon={<PencilSimple size={16} />}
									role="menuitem"
									onClick={act(() => {
										guard(m.path);
										setEdit({ kind: "rename", path: m.path, name: m.name, dir: m.dir });
									})}
								>
									Rename…
								</MenuItem>
								<MenuItem icon={<Trash size={16} />} role="menuitem" onClick={act(() => trash(m))}>
									Delete
								</MenuItem>
							</>
						)}
					</ContextMenu>
				);
			})()}
		</section>
	);
}
