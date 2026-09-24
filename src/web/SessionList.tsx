import { useEffect, useMemo, useState } from "react";
import { CaretUpDown, FolderPlus, Plus, X } from "@phosphor-icons/react";
import type { PiSessionInfo } from "../shared/types.js";
import { SESSION_SORTS, type SessionSort } from "./prefs.js";
import { DirectoryPicker } from "./DirectoryPicker.js";
import { sessionLabel, shortName } from "./sessionName.js";

/** The menu's own box, needed before it renders so it can be kept on screen. */
const MENU_WIDTH_PX = 220;
const MENU_HEIGHT_PX = 116;

/** The timestamp a row shows, which is always the one it is sorted by. */
function stamp(s: PiSessionInfo, sort: SessionSort): string {
	return sort === "created" ? s.created : s.lastActive;
}

function timeAgo(iso: string): string {
	const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 30) return `${d}d ago`;
	const mo = Math.floor(d / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.floor(mo / 12)}y ago`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "long",
});

/**
 * The project list this pwi reports: every directory, plus the cwd it was
 * launched against.
 */
export interface Projects {
	projects: string[];
	/** This pwi's startup cwd: always listed, never removable. */
	seed: string;
	error?: string;
}

/**
 * Left panel: flat, read-only list of EVERY session in the project.
 *
 * Read-only means no delete, no archive, no rename: the session file is
 * pi's, and a UI that deletes an agent's memory should have to be very sure
 * of itself. The list shows what is on disk; managing it is the TUI's job.
 *
 * One project at a time: the dropdown swaps which cwd's sessions are listed,
 * which keeps the 5s poll at exactly one request.
 */
export function SessionList({
	sessions,
	listError,
	activeFile,
	openFiles,
	projects,
	project,
	sort,
	onSort,
	open,
	onToggle,
	onProject,
	onAddProject,
	onRemoveProject,
	onSelect,
	onRename,
	onAutoName,
	shortNames,
	onNew,
}: {
	sessions: PiSessionInfo[];
	/** Why the listing failed, when it did; shown instead of "No sessions yet". */
	listError: string | null;
	activeFile: string | undefined;
	/** Sessions that already have a tab; clicking one just focuses it. */
	openFiles: string[];
	/** This machine's directories. A project IS a cwd. */
	projects: Projects;
	/** The selected project: a cwd on this machine. */
	project: string;
	sort: SessionSort;
	onSort: (sort: SessionSort) => void;
	/** Drawer state. Only observable at <=768px, where this is an overlay. */
	open: boolean;
	onToggle: () => void;
	onProject: (cwd: string) => void;
	onAddProject: (path: string) => void;
	onRemoveProject: (path: string) => void;
	onSelect: (s: PiSessionInfo) => void;
	/** Rename one session. pi owns the name, so this is a server round trip. */
	onRename: (s: PiSessionInfo, name: string) => void;
	/**
	 * Hand the naming to the server: a one-shot `pi -p` child turns the
	 * session's opening request into a title. Awaited, so the row can say it
	 * is working — this one can take seconds, unlike the local derivation.
	 */
	onAutoName: (s: PiSessionInfo) => Promise<void>;
	/** Label unnamed sessions by a short name from the first prompt. */
	shortNames: boolean;
	onNew: () => void;
}) {
	/*
	 * The selection stays in the list even while the list has not arrived (or
	 * failed to), so the dropdown never shows a blank for the project whose
	 * sessions are on screen.
	 */
	const options = useMemo(
		() =>
			projects.projects.length > 0 || !project ? projects.projects : [project],
		[projects.projects, project],
	);

	/*
	 * Dropdown labels. The basename alone is what you think of the project as,
	 * but two checkouts of the same repo are then the same word twice — so a
	 * basename that is not unique carries its parent directory.
	 */
	const labelFor = useMemo(() => {
		const base = (p: string) => p.split("/").filter(Boolean).pop() || p;
		const counts = new Map<string, number>();
		for (const p of options) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
		return (p: string) => {
			const parts = p.split("/").filter(Boolean);
			const name = parts.at(-1) || p;
			return (counts.get(name) ?? 0) > 1 && parts.length > 1
				? `${parts.at(-2)}/${name}`
				: name;
		};
	}, [options]);

	/*
	 * Sorted here rather than on the server: both timestamps are already on
	 * the wire, the list is small, and switching order must not wait for a
	 * request. Descending in both modes — a session list is read newest-first
	 * in either question it answers.
	 */
	const ordered = useMemo(
		() => [...sessions].sort((a, b) => stamp(b, sort).localeCompare(stamp(a, sort))),
		[sessions, sort],
	);

	/*
	 * The add-project explorer. Local state, not lifted: nothing outside this
	 * panel opens it, and it is a <dialog> in the top layer, so living inside
	 * the drawer's subtree costs it nothing in stacking or inertness.
	 */
	const [pickerOpen, setPickerOpen] = useState(false);

	/*
	 * Which row is being renamed, and the text in it. Local, like the picker:
	 * a half-typed name belongs to this panel and to nothing else, and nothing
	 * outside it can start a rename.
	 */
	const [renaming, setRenaming] = useState<string | null>(null);
	const [draft, setDraft] = useState("");

	/*
	 * The open row menu: which session, and where the pointer was. Closed by
	 * anything that would make its position a lie — a click, Escape, a scroll,
	 * a resize — which is also every gesture that means "not this".
	 */
	const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
	/** The row waiting on a generated name, so it can say so instead of looking idle. */
	const [naming, setNaming] = useState<string | null>(null);

	useEffect(() => {
		if (!menu) return;
		const close = () => setMenu(null);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		// `capture` on scroll: a scroll inside the list does not bubble, and an
		// anchored menu left behind by one is worse than no menu.
		window.addEventListener("pointerdown", close);
		window.addEventListener("scroll", close, true);
		window.addEventListener("resize", close);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", close);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [menu]);

	const menuSession = menu ? sessions.find((s) => s.path === menu.path) : undefined;

	return (
		<>
			{/* Dismiss-by-tapping-away. Pointer-only affordance by design: the
			    drawer also has a real, focusable close button. */}
			{open && (
				<div
					aria-hidden
					onClick={onToggle}
					className="fixed inset-0 z-20 bg-black/60 wide:hidden"
				/>
			)}

			{/*
			  Two layouts, one element: a static column from 769px up, a fixed
			  overlay below it. `hidden wide:flex` rather than a JS media
			  query so the correct layout is in the first paint.
			*/}
			<aside
				id="session-list"
				aria-label="All sessions"
				// Right edge now, opposite the activity rail: `border-l` and the
				// drawer anchored to `right-0`, or it would slide in from the side it
				// no longer lives on.
				className={`w-72 shrink-0 flex-col border-l border-neutral-800 bg-neutral-950 narrow:fixed narrow:inset-y-0 narrow:right-0 narrow:z-30 narrow:w-[min(20rem,85vw)] narrow:shadow-2xl ${
					open ? "flex" : "hidden wide:flex"
				}`}
			>
				<div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
					<span className="text-sm font-semibold tracking-tight">pwi</span>
					<button
						onClick={onToggle}
						aria-label="Hide session list"
						title="Hide sessions"
						className="size-8 rounded text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none wide:hidden"
					>
						<X size={13} />
					</button>
				</div>

				{/*
				  Project picker. One active project at a time: the dropdown swaps which
				  cwd's sessions are listed, which keeps the 5s poll at exactly one
				  request. Showing every project at once would mean parsing every session
				  file on the machine on every tick.

				  Adding opens a folder explorer over the SERVER's filesystem
				  (DirectoryPicker): the browser cannot enumerate it, and its own
				  directory input would offer the wrong folders entirely.
				*/}
				<div className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1.5">
					<select
						value={project}
						onChange={(e) => onProject(e.target.value)}
						title={project}
						className="min-w-0 flex-1 truncate rounded bg-neutral-900 px-1.5 py-1 text-xs text-neutral-300 outline-none"
					>
						{options.map((p) => (
							<option key={p} value={p}>
								{labelFor(p)}
							</option>
						))}
					</select>
					{/* A folder icon, not a bare `+`: the other `+` on this panel
					    makes a session, and two identical glyphs for two different
					    nouns is the whole confusion. */}
					<button
						onClick={() => setPickerOpen(true)}
						disabled={!!projects.error}
						aria-label="Add project directory"
						title="Add project directory"
						className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-40 motion-reduce:transition-none"
					>
						<FolderPlus size={13} />
					</button>
					{/*
					  Removing is offered for every project except the one pwi was
					  launched against: that one is seeded back by the server on every
					  read, so a button for it would appear to do nothing.

					  Still confirmed, even now that adding is a picker — the wording has
					  to say what is NOT happening, since "remove project" in most tools
					  means the files.
					*/}
					{project && !projects.error && project !== projects.seed && (
						<button
							onClick={() => {
								if (
									confirm(
										`Remove ${project} from the project list?\n\nThe directory and its sessions stay on disk — this only hides them here.`,
									)
								) {
									onRemoveProject(project);
								}
							}}
							aria-label={`Remove ${project} from the list`}
							title="Remove this project from the list (keeps sessions on disk)"
							className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
						>
							<X size={13} />
						</button>
					)}
				</div>

				{/*
				  Sort mode. Two orders, one button, because a dropdown for a
				  binary choice is a click more for the same information.

				  `created` is the default and the only one that cannot move on
				  its own: it is the header timestamp, written once. Ordering by
				  file mtime — which is what this list used to do — meant a
				  session jumped to the top just from being opened, so `active`
				  reads the timestamp of the last message in the file instead.
				*/}
				{/*
				  New session sits BELOW the project picker because that is the
				  order the two are read in: the button makes a session in the
				  selected project, so offering it first asked the question before
				  showing the answer.
				*/}
				<div className="border-b border-neutral-800 px-2 py-1.5">
					<button
						onClick={onNew}
						className="flex w-full items-center justify-center gap-1.5 rounded bg-neutral-800 px-2 py-1.5 text-xs transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
					>
						<Plus size={12} />
						New session
					</button>
				</div>

				<div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1">
					<span className="text-[10px] tracking-wide text-neutral-500 uppercase">
						{sessions.length} {sessions.length === 1 ? "session" : "sessions"}
					</span>
					{/* Bordered, with an up/down caret: unstyled text on a row that
					    reads as a table header looks like a column title, not a
					    control. */}
					<button
						onClick={() => onSort(sort === "created" ? "active" : "created")}
						title="Switch between newest-created and most-recently-active"
						className="flex items-center gap-1 rounded border border-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors duration-150 ease-out hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
					>
						{SESSION_SORTS.find((s) => s.id === sort)?.label}
						<CaretUpDown size={10} />
					</button>
				</div>

				{/* min-h-0 for the same reason as the transcript: a flex item is
				    `min-height: auto` by default, so a long list would push the
				    panel past the viewport and scroll the whole page instead of
				    itself. */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{listError ? (
						<p className="px-3 py-4 text-xs text-red-400" role="alert">
							{listError}
						</p>
					) : (
						sessions.length === 0 && (
							<p className="px-3 py-4 text-xs text-neutral-400">No sessions yet.</p>
						)
					)}
					{ordered.map((s) => {
						const isOpen = openFiles.includes(s.path);
						const label = sessionLabel(s, shortNames);

						/*
						 * Renaming replaces the row rather than opening a dialog: the
						 * thing being named is in front of you, and the new name lands
						 * exactly where the old one was.
						 *
						 * Enter commits. Escape and a click elsewhere BOTH cancel —
						 * committing on blur would write a half-typed name from a
						 * misclick, and a name is cheap to retype but annoying to undo.
						 */
						if (renaming === s.path) {
							return (
								<form
									key={s.path}
									onSubmit={(e) => {
										e.preventDefault();
										const next = draft.trim();
										setRenaming(null);
										if (next && next !== s.name) onRename(s, next);
									}}
									className="border-b border-neutral-900 px-2 py-1.5"
								>
									<input
										autoFocus
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape") setRenaming(null);
										}}
										onBlur={() => setRenaming(null)}
										aria-label={`Rename ${label}`}
										className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-xs text-neutral-100 outline-none"
									/>
									<p className="mt-0.5 text-[10px] text-neutral-500">
										Enter to save, Escape to cancel
									</p>
								</form>
							);
						}

						return (
							<button
								key={s.path}
								onClick={() => onSelect(s)}
								/*
								 * Right-click (and the keyboard's own menu key, which fires
								 * the same event) opens the row menu. No always-visible
								 * affordance: naming is rare next to opening, and a control
								 * per row is forty controls down the panel.
								 */
								onContextMenu={(e) => {
									e.preventDefault();
									// A keyboard-raised menu reports (0,0); anchor it to the
									// row instead so it does not land in the corner.
									const box = e.currentTarget.getBoundingClientRect();
									setMenu({
										path: s.path,
										x: e.clientX || box.left + 16,
										y: e.clientY || box.bottom,
									});
								}}
								aria-current={s.path === activeFile ? "true" : undefined}
								aria-haspopup="menu"
								title={s.name || s.firstMessage || s.path}
								className={`block w-full border-b border-neutral-900 px-3 py-2 text-left transition-colors duration-150 ease-out hover:bg-neutral-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
									// Three states worth telling apart: selected, open in a
									// background tab, and not open at all.
									s.path === activeFile
										? "bg-neutral-800"
										: isOpen
											? "bg-neutral-900/60"
											: ""
								}`}
							>
								<div className="flex items-center gap-1.5 truncate text-xs text-neutral-200">
									{/* Live indicator for background work — visible even when this
									    session isn't the one currently attached. */}
									{s.isStreaming && (
										<span
											className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
											title="Working…"
										/>
									)}
									<span className="truncate">
										{naming === s.path ? "Naming…" : label}
									</span>
								</div>
								{/*
								  The stamp shown is the one the list is sorted by, so the
								  order is always explained by what each row displays. The
								  tooltip carries both, because "created two days ago, last
								  touched an hour ago" is exactly the question the other
								  sort mode exists to answer.
								*/}
								<div
									className="mt-0.5 text-[10px] text-neutral-400"
									title={`Created ${dateFmt.format(new Date(s.created))}, ${timeAgo(
										s.created,
									)} · last active ${timeAgo(s.lastActive)}`}
								>
									{dateFmt.format(new Date(stamp(s, sort)))}, {timeAgo(stamp(s, sort))} ·{" "}
									{s.messageCount} msg
								</div>
							</button>
						);
					})}
				</div>

			</aside>

			{/*
			  The row menu. `fixed` and positioned from the pointer, outside the
			  <aside> so the panel's own scrolling and overflow cannot clip it.
			  Closed by the effect above before any action runs, so a click never
			  leaves a stale menu over the list.
			*/}
			{menuSession && menu && (
				<div
					role="menu"
					aria-label={`Session ${sessionLabel(menuSession, shortNames)}`}
					// The listener that dismisses this is on `pointerdown` at the
					// window, so the menu has to keep its own clicks to itself.
					onPointerDown={(e) => e.stopPropagation()}
					style={{
						// Clamped so a right-click near the bottom or right edge does
						// not open a menu half off screen.
						left: Math.min(menu.x, window.innerWidth - MENU_WIDTH_PX - 8),
						top: Math.min(menu.y, window.innerHeight - MENU_HEIGHT_PX - 8),
						width: MENU_WIDTH_PX,
					}}
					className="fixed z-40 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 py-1 text-xs shadow-2xl"
				>
					<button
						role="menuitem"
						autoFocus
						onClick={() => {
							setDraft(sessionLabel(menuSession, shortNames));
							setRenaming(menuSession.path);
							setMenu(null);
						}}
						className="block w-full px-3 py-1.5 text-left text-neutral-200 transition-colors duration-150 ease-out hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none motion-reduce:transition-none"
					>
						Rename…
					</button>
					{/*
					  The two automatic options, cheapest first. Naming from the
					  first prompt is local and instant; summarising spends a model
					  call and a few seconds on the opening request.
					*/}
					<button
						role="menuitem"
						disabled={!menuSession.firstMessage?.trim()}
						onClick={() => {
							const next = shortName(menuSession.firstMessage ?? "");
							setMenu(null);
							if (next) onRename(menuSession, next);
						}}
						className="block w-full px-3 py-1.5 text-left text-neutral-200 transition-colors duration-150 ease-out hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none disabled:text-neutral-600 disabled:hover:bg-transparent motion-reduce:transition-none"
					>
						Name from first prompt
					</button>
					<button
						role="menuitem"
						onClick={() => {
							setMenu(null);
							setNaming(menuSession.path);
							void onAutoName(menuSession).finally(() => setNaming(null));
						}}
						className="block w-full px-3 py-1.5 text-left text-neutral-200 transition-colors duration-150 ease-out hover:bg-neutral-800 focus-visible:bg-neutral-800 focus-visible:outline-none motion-reduce:transition-none"
					>
						Summarise with pi
						<span className="block text-[10px] text-neutral-500">
							Asks pi to title the conversation
						</span>
					</button>
				</div>
			)}

			{/* Mounted next to the panel that opens it. `open` drives showModal(),
			    so an unopened picker never fetches a listing. */}
			<DirectoryPicker
				open={pickerOpen}
				start={project}
				projects={projects.projects}
				onPick={(p) => {
					onAddProject(p);
					setPickerOpen(false);
				}}
				onClose={() => setPickerOpen(false)}
			/>
		</>
	);
}
