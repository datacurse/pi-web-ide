import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "@phosphor-icons/react";
import type { KeyboardEvent } from "react";
import type { PiSessionInfo } from "../shared/types.js";
import { sessionLabel } from "./sessionName.js";
import { FileGlyph } from "./fileIcon.js";
import { isFileTab, tabLabel, tabPath } from "./tabs.js";

/**
 * DOM id of the Nth tab. Shared with App, which points the chat panel's
 * `aria-labelledby` at the selected tab — the two ids have to agree, so the
 * scheme lives in one place instead of being spelled out twice.
 */
export const tabDomId = (index: number) => `session-tab-${index}`;

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
	onNew,
	onToggleList,
	shortNames,
	dirtyFiles,
	onReorder,
}: {
	/** Open session files, in strip order. */
	tabs: string[];
	/** The polled session list, used for titles and live state. */
	sessions: PiSessionInfo[];
	active: string | undefined;
	/** Element the tabs control — the chat panel. */
	panelId: string;
	listOpen: boolean;
	onSelect: (file: string) => void;
	onClose: (file: string) => void;
	onNew: () => void;
	onToggleList: () => void;
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
	const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
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
			<button
				onClick={onToggleList}
				aria-expanded={listOpen}
				aria-controls="session-list"
				aria-label={listOpen ? "Hide session list" : "Show session list"}
				title="Sessions"
				className="size-9 shrink-0 self-center rounded text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none wide:hidden"
			>
				<span aria-hidden>{"\u2261"}</span>
			</button>

			{/* Left of the strip, outside the scrolling region: a "+" that scrolls
			    away with twenty open tabs is a "+" you cannot click, and the left
			    edge is where the strip's chrome already lives. */}
			<button
				onClick={onNew}
				aria-label="New session"
				title="New session"
				className="flex size-9 shrink-0 items-center justify-center self-center rounded text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
			>
				<Plus size={16} />
			</button>

			<div
				role="tablist"
				aria-label="Open sessions"
				aria-orientation="horizontal"
				// An empty tablist must not claim the free space, or the hint next to
				// it is pushed into the middle of the strip.
				className={`tab-strip flex min-w-0 items-stretch gap-1 overflow-x-auto ${
					tabs.length > 0 ? "flex-1" : "flex-none"
				}`}
			>
				{tabs.map((file, i) => {
					const isFile = isFileTab(file);
					const info = isFile ? undefined : byFile.get(file);
					const label = isFile ? tabLabel(file) : sessionLabel(file, info, shortNames);
					const isActive = file === active;
					const dirty = isFile && dirtyFiles[tabPath(file)] === true;
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
								setDrag({ from: i, to: i });
								e.dataTransfer.effectAllowed = "move";
								// Firefox starts no drag at all unless some data is set.
								e.dataTransfer.setData("text/plain", file);
							}}
							onDragOver={(e) => {
								const from = dragFrom.current;
								if (from === null) return;
								// Without preventDefault the browser refuses the drop and the
								// tab animates back to where it started.
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
								if (drag?.to !== i) setDrag({ from, to: i });
							}}
							onDrop={(e) => {
								const from = dragFrom.current;
								dragFrom.current = null;
								setDrag(null);
								if (from === null || from === i) return;
								e.preventDefault();
								onReorder(from, i);
							}}
							// Dropping outside the strip, or pressing Escape, ends the drag
							// without a drop — the marker has to be cleared either way.
							onDragEnd={() => {
								dragFrom.current = null;
								setDrag(null);
							}}
							className={`group relative flex shrink-0 py-1 ${
								drag?.from === i ? "opacity-40" : ""
							} ${
								/* Where it would land: a line on the side it is coming from,
								   so the marker sits between the two tabs it separates. */
								drag && drag.to === i && drag.from !== i
									? drag.from < i
										? "shadow-[inset_-2px_0_0_0_var(--color-amber-400)]"
										: "shadow-[inset_2px_0_0_0_var(--color-amber-400)]"
									: ""
							}`}
						>
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
								title={isFile ? tabPath(file) : label}
								onClick={() => onSelect(file)}
								onKeyDown={(e) => moveFocus(e, i)}
								className={`flex h-8 max-w-52 items-center gap-1.5 rounded-t border-t-2 pr-7 pl-2.5 text-xs transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
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
								{/* Same glyph the tree uses, so a tab and its row match. */}
								{isFile && <FileGlyph name={label} size={13} />}
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
								className={`tab-close absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded text-sm leading-none text-neutral-400 transition-opacity duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:bg-neutral-700 hover:text-neutral-50 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
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
			</div>

			{tabs.length === 0 && (
				<p className="min-w-0 flex-1 self-center truncate px-2 text-xs text-neutral-400">
					No open sessions. Press + or pick one from the list.
				</p>
			)}

		</div>
	);
}
