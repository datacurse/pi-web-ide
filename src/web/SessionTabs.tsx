import { useEffect, useMemo, useRef, useState } from "react";
import { GitDiff, X } from "@phosphor-icons/react";
import type { KeyboardEvent } from "react";
import type { PiSessionInfo } from "../shared/types.js";
import { sessionLabel } from "./sessionName.js";
import { FileGlyph } from "./fileIcon.js";
import { diffParts, isDiffTab, isSessionTab, tabLabel, tabPath } from "./tabs.js";

/**
 * A diff tab's tooltip: the long form VS Code puts in the tab itself.
 *
 * The strip shows `name (sha)`; which two things are being compared only
 * matters when you stop to ask, and that is what a hover is for.
 */
const diffTitle = (entry: string): string => {
	const { ref, path } = diffParts(entry);
	return ref ? `${path} — ${ref.slice(0, 7)} ↔ parent` : `${path} — HEAD ↔ working tree`;
};

/**
 * DOM id of the Nth tab. Shared with App, which points the chat panel's
 * `aria-labelledby` at the selected tab — the two ids have to agree, so the
 * scheme lives in one place instead of being spelled out twice.
 */
export const tabDomId = (index: number) => `session-tab-${index}`;

/**
 * The drag payload for a tab, as a dataTransfer TYPE rather than its data.
 *
 * Data cannot be read during `dragover` (browsers protect it until drop), but
 * the type list can — so the editor's drop zones need the entry encoded in a
 * type to know whether an arbitrary drag over them is one of ours. Lowercase
 * because the DOM lowercases every type it stores.
 */
export const TAB_DRAG_TYPE = "application/x-pwi-tab";

/** Whether a drag in progress is one of our tabs, decidable during dragover. */
export const isTabDrag = (types: readonly string[]): boolean => types.includes(TAB_DRAG_TYPE);

/**
 * Which SLOT a pointer aims at, over the tab at `index`.
 *
 * A slot is a GAP, numbered 0..tabs.length — slot 2 means "between tab 1 and
 * tab 2". Past the tab's midpoint means the gap after it, which is what makes
 * a drag feel like it is pointing somewhere: aiming at a tab's left half puts
 * the tab before it, the right half after it, instead of every hover over one
 * tab meaning the same single position.
 *
 * Pure and exported so the boundary is testable without a drag.
 */
export function slotFor(x: number, left: number, width: number, index: number): number {
	return x < left + width / 2 ? index : index + 1;
}

/**
 * The tab strip: this project's open chat sessions AND open files, in one
 * list, the way an editor's is.
 *
 * One strip rather than two because they are the same gesture — you switch
 * between a conversation and the file it is about constantly, and a second
 * strip would mean a second place to look and a second thing to close.
 *
 * Only the selected session is attached (one EventSource, per App); the strip
 * is otherwise driven entirely by the session list the app already polls, so
 * a background session's live dot costs no extra request. That is also why a
 * tab can be closed without consequence — the tab is client-side state, the
 * run and the file are not.
 *
 * Keyboard handling follows the ARIA tabs pattern with MANUAL activation:
 * arrows move focus, the native button activation selects. Automatic
 * activation would open (and stream) every session arrowed past.
 */
export function SessionTabs({
	tabs,
	sessions,
	active,
	panelId,
	listOpen,
	onSelect,
	onClose,
	onToggleList,
	shortNames,
	dirtyFiles,
	onReorder,
	onAdopt,
	label = "Open sessions",
}: {
	/** Open session files, in strip order. */
	tabs: string[];
	/** The polled session list, used for titles and live state. */
	sessions: PiSessionInfo[];
	active: string | undefined;
	/** Element the tabs control — the chat panel. */
	panelId: string;
	listOpen?: boolean;
	onSelect: (file: string) => void;
	onClose: (file: string) => void;
	/*
	 * Absent in the split's second column: it holds files only, so there is no
	 * session list to toggle. Optional rather than a `variant` flag — the
	 * button is gone exactly when the callback that makes it do anything is.
	 */
	onToggleList?: () => void;
	/**
	 * Take a tab dropped from the OTHER column. Absent means this strip does
	 * not accept them, which is the single-column case.
	 */
	onAdopt?: (entry: string, index: number) => void;
	/** Distinguishes the two strips for a screen reader. */
	label?: string;
	/** Label unnamed sessions by a short name from the first prompt. */
	shortNames: boolean;
	/** Open files with unsaved edits, keyed by absolute path. */
	dirtyFiles: Record<string, boolean>;
	/** Move the tab at `from` to index `to`. */
	onReorder: (from: number, to: number) => void;
}) {
	const buttons = useRef<Array<HTMLButtonElement | null>>([]);
	/*
	 * Drag state for REORDERING, which is view state and not App's: only the
	 * committed order matters upstream, and lifting the in-flight index would
	 * re-render the whole app on every dragover event.
	 *
	 * `from` is held in a ref as well as state because dataTransfer cannot be
	 * read during dragover in several browsers (it is protected until drop),
	 * and the insertion marker has to be drawn before then.
	 */
	const dragFrom = useRef<number | null>(null);
	/**
	 * The in-flight drag: where it started, and the gap it is aiming at.
	 *
	 * `from` is null for a tab dragged in from the OTHER column — that is an
	 * insertion rather than a move, and it is the case that previously drew
	 * nothing at all, so a cross-column drag gave no clue where it would land.
	 */
	const [drag, setDrag] = useState<{ from: number | null; slot: number } | null>(null);

	/** Aim at `slot`, skipping the re-render when it has not changed. */
	const aim = (from: number | null, slot: number) => {
		setDrag((d) => (d && d.from === from && d.slot === slot ? d : { from, slot }));
	};

	/*
	 * The gap to draw the marker in, or -1 for none.
	 *
	 * A same-strip drag hides the marker at the two slots that mean "where it
	 * already is": a line promising a move that would not move anything reads
	 * as a bug.
	 */
	const markSlot =
		drag && !(drag.from !== null && (drag.slot === drag.from || drag.slot === drag.from + 1))
			? drag.slot
			: -1;
	const byFile = useMemo(() => new Map(sessions.map((s) => [s.path, s])), [sessions]);
	const activeIndex = active ? tabs.indexOf(active) : -1;

	// A tab can be selected by Alt+N or by a click in the session list, neither
	// of which scrolls the strip; without this the selected tab can sit off
	// screen. `nearest` on both axes so it never scrolls anything else.
	useEffect(() => {
		if (activeIndex < 0) return;
		buttons.current[activeIndex]?.scrollIntoView({
			block: "nearest",
			inline: "nearest",
		});
	}, [activeIndex, tabs.length]);

	const moveFocus = (e: KeyboardEvent<HTMLButtonElement>, from: number) => {
		const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : undefined;
		/*
		 * Ctrl+Shift+Arrow MOVES the tab instead of moving focus, so reordering
		 * is reachable without a pointer — a drag handle is not operable by
		 * keyboard at all, and this is the same binding VS Code uses.
		 *
		 * Clamped rather than wrapped: dragging past the end stops at the end,
		 * and a key that teleports the first tab to last is a key you undo.
		 */
		if (step !== undefined && e.ctrlKey && e.shiftKey) {
			const target = Math.min(Math.max(from + step, 0), tabs.length - 1);
			if (target === from) return;
			e.preventDefault();
			onReorder(from, target);
			// Focus follows the tab, not the slot: the hand is still on the key
			// and the next press must move the SAME tab again.
			requestAnimationFrame(() => buttons.current[target]?.focus());
			return;
		}
		const to =
			step !== undefined
				? (from + step + tabs.length) % tabs.length
				: e.key === "Home"
					? 0
					: e.key === "End"
						? tabs.length - 1
						: -1;
		if (to < 0) return;
		e.preventDefault();
		buttons.current[to]?.focus();
	};

	return (
		<div className="flex items-stretch gap-1 border-b border-neutral-800 bg-neutral-950 px-1">
			{/*
			  On a narrow viewport the session list is a drawer, so its toggle has
			  to live somewhere permanent. The strip's left edge is where a tab bar
			  already carries chrome, and it stays out of the scrolling region.
			*/}
			{onToggleList && (
			<button
				onClick={onToggleList}
				aria-expanded={listOpen}
				aria-controls="session-list"
				aria-label={listOpen ? "Hide session list" : "Show session list"}
				title="Sessions"
				className="size-9 shrink-0 self-center rounded-sm text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none wide:hidden"
			>
				<span aria-hidden>{"\u2261"}</span>
			</button>
			)}

			<div
				role="tablist"
				aria-label={label}
				aria-orientation="horizontal"
				/*
				 * A tab dragged from the OTHER column lands here. The strip itself
				 * takes the drop as well as each tab, so dropping on the empty space
				 * past the last tab appends rather than doing nothing — which is the
				 * whole target when the column is empty.
				 */
				onDragOver={(e) => {
					const from = dragFrom.current;
					if (from === null && !onAdopt) return;
					if (!isTabDrag(e.dataTransfer.types)) return;
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					// Only fires for the space PAST the last tab: a tab's own handler
					// stops the event before it bubbles here.
					aim(from, tabs.length);
				}}
				// dragleave fires on every internal boundary, so clear only when the
				// pointer actually left the strip — otherwise the marker flickers off
				// each time it crosses between two tabs.
				onDragLeave={(e) => {
					if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(null);
				}}
				// A wheel over the strip scrolls it sideways: the strip only scrolls
				// horizontally and a mouse has no horizontal wheel, so the vertical
				// delta is the only gesture most pointers can make here. A trackpad's
				// own horizontal delta is left to the browser.
				onWheel={(e) => {
					if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
					e.currentTarget.scrollLeft += e.deltaY;
				}}
				onDrop={(e) => {
					const from = dragFrom.current;
					dragFrom.current = null;
					setDrag(null);
					if (from !== null) {
						e.preventDefault();
						// Dropped past the last tab: send it to the end.
						if (from !== tabs.length - 1) onReorder(from, tabs.length - 1);
						return;
					}
					const entry = onAdopt ? e.dataTransfer.getData(TAB_DRAG_TYPE) : "";
					if (!entry) return;
					e.preventDefault();
					onAdopt?.(entry, tabs.length);
				}}
				// An empty tablist must not claim the free space, or the hint next to
				// it is pushed into the middle of the strip. It does claim it when it
				// is a drop target, because an empty column needs somewhere to aim.
				className={`tab-strip flex min-w-0 items-stretch gap-1 overflow-x-auto ${
					tabs.length > 0 || onAdopt ? "flex-1" : "flex-none"
				}`}
			>
				{tabs.map((file, i) => {
					// A DOCUMENT tab: a file or a diff. `!isSessionTab` and not
					// `isFileTab`, because a diff is not a file entry — testing for the
					// file prefix sent every diff down the session branch, where it had
					// no session to look up and rendered as "New session".
					const isFile = !isSessionTab(file);
					const isDiff = isDiffTab(file);
					const info = isFile ? undefined : byFile.get(file);
					const label = isFile ? tabLabel(file) : sessionLabel(info, shortNames);
					const isActive = file === active;
					// Only an editable file can be dirty; a diff is read-only.
					const dirty = isFile && !isDiff && dirtyFiles[tabPath(file)] === true;
					return (
						// Wrapper because the close control cannot be a <button> inside
						// the tab's <button>; role="presentation" keeps the tablist's
						// owned children the tabs themselves.
						<div
							key={file}
							role="presentation"
							draggable
							onDragStart={(e) => {
								dragFrom.current = i;
								// Aimed at its own slot, which draws no marker — the tab has
								// not been dragged anywhere yet.
								setDrag({ from: i, slot: i });
								e.dataTransfer.effectAllowed = "move";
								// Firefox starts no drag at all unless some data is set.
								e.dataTransfer.setData("text/plain", file);
								// The entry rides in the TYPE as well as the data: the
								// editor's split zones have to recognise our drag during
								// dragover, where the data is unreadable.
								e.dataTransfer.setData(TAB_DRAG_TYPE, file);
							}}
							onDragOver={(e) => {
								const from = dragFrom.current;
								// Null `from` with our type on the drag means it started in the
								// other column: an insertion rather than a move, but it aims at
								// a slot and gets a marker exactly like a local drag.
								if (from === null && !onAdopt) return;
								if (!isTabDrag(e.dataTransfer.types)) return;
								// Without preventDefault the browser refuses the drop and the
								// tab animates back to where it started.
								e.preventDefault();
								// The strip's own handler means "past the last tab"; over a tab
								// it must not overwrite the slot we just worked out.
								e.stopPropagation();
								e.dataTransfer.dropEffect = "move";
								const r = e.currentTarget.getBoundingClientRect();
								aim(from, slotFor(e.clientX, r.left, r.width, i));
							}}
							onDrop={(e) => {
								const from = dragFrom.current;
								dragFrom.current = null;
								setDrag(null);
								// Recomputed from the drop's OWN coordinates rather than read
								// back from state: dragleave fires before drop, so the state
								// the marker used may already be cleared.
								const r = e.currentTarget.getBoundingClientRect();
								const slot = slotFor(e.clientX, r.left, r.width, i);
								if (from === null) {
									const entry = onAdopt ? e.dataTransfer.getData(TAB_DRAG_TYPE) : "";
									if (!entry) return;
									e.preventDefault();
									// Stop the strip's own handler from appending it as well.
									e.stopPropagation();
									onAdopt?.(entry, slot);
									return;
								}
								e.preventDefault();
								e.stopPropagation();
								// Slot to index: removing the tab first shifts every later slot
								// down one.
								const to = slot > from ? slot - 1 : slot;
								if (to !== from) onReorder(from, to);
							}}
							// Dropping outside the strip, or pressing Escape, ends the drag
							// without a drop — the marker has to be cleared either way.
							onDragEnd={() => {
								dragFrom.current = null;
								setDrag(null);
							}}
							className={`group relative flex shrink-0 py-1 ${
								// The tab being dragged fades, so the marker is clearly a
								// destination and not the tab itself.
								drag?.from === i ? "opacity-40" : ""
							}`}
						>
							{/*
							 * The insertion marker, drawn IN THE GAP between two tabs
							 * rather than as an inset edge on one of them — an inset line
							 * reads as a border the tab grew, which is why this looked
							 * wrong. Sitting in the gap, it reads as the seam the tab is
							 * about to be dropped into.
							 *
							 * pointer-events-none so the marker cannot become the drag
							 * target and start flickering against its own hover.
							 */}
							{markSlot === i && (
								<span
									aria-hidden
									className="pointer-events-none absolute inset-y-1 -left-[3px] w-0.5 rounded-full bg-amber-400"
								/>
							)}
							{/* The last gap has no tab after it to hang off. */}
							{markSlot === tabs.length && i === tabs.length - 1 && (
								<span
									aria-hidden
									className="pointer-events-none absolute inset-y-1 -right-[3px] w-0.5 rounded-full bg-amber-400"
								/>
							)}
							<button
								ref={(el) => {
									buttons.current[i] = el;
								}}
								role="tab"
								id={tabDomId(i)}
								aria-selected={isActive}
								aria-controls={panelId}
								// Roving tabindex: Tab reaches the strip once, arrows walk it.
								// When nothing is selected the first tab is the entry point.
								tabIndex={isActive || (activeIndex < 0 && i === 0) ? 0 : -1}
								title={isDiff ? diffTitle(file) : isFile ? tabPath(file) : label}
								onClick={() => onSelect(file)}
								onKeyDown={(e) => moveFocus(e, i)}
								className={`flex h-8 max-w-52 items-center gap-1.5 rounded-t-sm border-t-2 pr-7 pl-2.5 text-meta transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
									isActive
										? "border-amber-400 bg-neutral-800 font-semibold text-neutral-50"
										: "border-transparent text-neutral-300 hover:bg-neutral-900 hover:text-neutral-50"
								}`}
							>
								{/* Live even when this session is not the attached one — the
								    same signal, and the same amber dot, as the list. */}
								{info?.isStreaming && (
									<span
										aria-hidden
										className="size-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"
									/>
								)}
								{/* A diff reads as a diff at a glance, the way VS Code's does —
								    but as one glyph rather than "x (sha) ↔ x (sha)", which eats
								    a whole strip. The rest is in `tabLabel` and the tooltip. */}
								{isDiff && (
									<GitDiff size={13} weight="bold" className="shrink-0 text-neutral-400" />
								)}
								{/* Marks an AI session so it never reads as a code tab. */}
								{!isFile && (
									<span aria-hidden className="shrink-0 font-bold leading-none text-amber-400">
										π
									</span>
								)}
								{/* Same glyph the tree uses, so a tab and its row match. */}
								{isFile && !isDiff && <FileGlyph name={label} size={13} />}
								<span className={`truncate text-ellipsis ${isFile ? "font-mono" : ""}`}>
									{label}
								</span>
								{/* Unsaved. A dot rather than an asterisk in the label, so
								    the name stays readable at a narrow width. */}
								{dirty && (
									<span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-400" />
								)}
								{dirty && <span className="sr-only">, unsaved changes</span>}
								{info?.isStreaming && <span className="sr-only">, working</span>}
							</button>
							<button
								onClick={() => onClose(file)}
								aria-label={`Close tab ${label}`}
								title={
									isFile
										? dirty
											? "Close tab — unsaved edits will be lost"
											: "Close tab"
										: "Close tab (the session keeps running)"
								}
								className={`tab-close absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-ui leading-none text-neutral-400 transition-opacity duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-neutral-700 hover:text-neutral-50 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
									isActive
										? "opacity-100"
										: "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
								}`}
							>
								<X size={13} />
							</button>
						</div>
					);
				})}

				{/* An empty column still has to show where the drop lands, and has no
				    tab to hang the marker off. */}
				{tabs.length === 0 && markSlot === 0 && (
					<span
						aria-hidden
						className="pointer-events-none my-1 w-0.5 shrink-0 rounded-full bg-amber-400"
					/>
				)}
			</div>

			{tabs.length === 0 && (
				<p className="min-w-0 flex-1 self-center truncate px-2 text-meta text-neutral-400">
					No open sessions. Press + or pick one from the list.
				</p>
			)}

		</div>
	);
}
