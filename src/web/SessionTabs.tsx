import { useEffect, useMemo, useRef } from "react";
import { Plus, TerminalWindow, X } from "@phosphor-icons/react";
import type { KeyboardEvent } from "react";
import type { PiSessionInfo } from "../shared/types.js";
import { sessionLabel } from "./sessionName.js";

/**
 * DOM id of the Nth tab. Shared with App, which points the chat panel's
 * `aria-labelledby` at the selected tab — the two ids have to agree, so the
 * scheme lives in one place instead of being spelled out twice.
 */
export const tabDomId = (index: number) => `session-tab-${index}`;

/**
 * The session tab strip: open sessions of the current project, switched like
 * editor tabs.
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
	terminalOpen,
	onToggleTerminal,
	shortNames,
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
	terminalOpen: boolean;
	onToggleTerminal: () => void;
	/** Label unnamed sessions by a short name from the first prompt. */
	shortNames: boolean;
}) {
	const buttons = useRef<Array<HTMLButtonElement | null>>([]);
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
					const info = byFile.get(file);
					const label = sessionLabel(file, info, shortNames);
					const isActive = file === active;
					return (
						// Wrapper because the close control cannot be a <button> inside
						// the tab's <button>; role="presentation" keeps the tablist's
						// owned children the tabs themselves.
						<div
							key={file}
							role="presentation"
							className="group relative flex shrink-0 py-1"
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
								title={label}
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
								<span className="truncate text-ellipsis">{label}</span>
								{info?.isStreaming && <span className="sr-only">, working</span>}
							</button>
							<button
								onClick={() => onClose(file)}
								aria-label={`Close tab ${label}`}
								title="Close tab (the session keeps running)"
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

			{/* Outside the scrolling region: a "+" that scrolls away with twenty
			    open tabs is a "+" you cannot click. */}
			<button
				onClick={onNew}
				aria-label="New session"
				title="New session"
				className="flex size-9 shrink-0 items-center justify-center self-center rounded text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
			>
				<Plus size={16} />
			</button>

			{/* Next to "+", because both are "open something", and this is the
			    only always-visible place for it: a control on the terminal pane
			    itself could not open the pane. */}
			<button
				onClick={onToggleTerminal}
				aria-label={terminalOpen ? "Hide terminal" : "Show terminal"}
				aria-pressed={terminalOpen}
				title={
					terminalOpen
						? "Hide terminal (Ctrl+`) — the shell keeps running"
						: "Show terminal (Ctrl+`)"
				}
				className={`flex size-9 shrink-0 items-center justify-center self-center rounded transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
					terminalOpen ? "bg-neutral-800 text-amber-400" : "text-neutral-300"
				}`}
			>
				<TerminalWindow size={16} />
			</button>
		</div>
	);
}
