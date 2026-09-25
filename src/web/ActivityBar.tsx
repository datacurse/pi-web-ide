/**
 * ActivityBar.tsx — the icon rail down the far left.
 *
 * One home for every "show me a different panel" control, instead of the four
 * that were scattered across the tab strip's two ends and the session list's
 * footer. The rail is always visible and never scrolls, which is the property
 * those controls actually needed: a toggle that can be scrolled out of reach
 * by twenty open tabs is a toggle you cannot press.
 *
 * The panels are MUTUALLY EXCLUSIVE, the way an activity bar's always are:
 * one column, one divider, and clicking the lit icon closes it. That is why
 * the state upstream is a single `Panel` value rather than a boolean each —
 * "two panels open at once" is then not a state that exists to be got wrong.
 *
 * Settings is not a panel and stays a modal: it is a handful of preferences
 * you set and dismiss, not something you work beside.
 */

import type { ReactNode } from "react";
import { Code, GitBranch, Gear, SquaresFour, TerminalWindow } from "@phosphor-icons/react";
import type { Panel } from "./App.js";

/**
 * One rail button.
 *
 * `active` and `onClick` are all a toggle needs; the badge is optional and
 * only the changes button uses it. Kept local rather than exported — it is
 * the rail's own vocabulary, and a second consumer would mean the rail is
 * being reused somewhere it should not be.
 */
function RailButton({
	label,
	title,
	active,
	badge,
	onClick,
	children,
}: {
	label: string;
	title: string;
	/** Showing state. Omitted for buttons that open a dialog, not a panel. */
	active?: boolean;
	badge?: number;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			data-custom="activity bar item"
			onClick={onClick}
			aria-label={label}
			// Only a panel button gets `aria-pressed`: the settings button opens a
			// modal and would otherwise announce a state it does not have.
			aria-pressed={active}
			title={title}
			className={`relative flex size-11 shrink-0 items-center justify-center transition-colors duration-150 ease-out hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
				active ? "text-neutral-50" : "text-neutral-500"
			}`}
		>
			{/* The lit left edge, VS Code's own marker for the open panel. A
			    pseudo-element rather than a border so the icon does not shift by
			    2px when it lights up. */}
			{active && (
				<span aria-hidden className="absolute inset-y-1 left-0 w-0.5 rounded-r-sm bg-amber-400" />
			)}
			{children}
			{badge !== undefined && badge > 0 && (
				<>
					<span
						aria-hidden
						className="absolute right-1.5 bottom-1.5 flex min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-caption leading-4 font-semibold text-neutral-950"
					>
						{badge > 9 ? "9+" : badge}
					</span>
					<span className="sr-only">, {badge} uncommitted files</span>
				</>
			)}
		</button>
	);
}

export function ActivityBar({
	panel,
	onSelect,
	uncommitted,
	onSettings,
	version,
}: {
	/** The panel showing now, or null when the chat has the whole width. */
	panel: Panel;
	/** Show this panel — or close it, when it is already the one showing. */
	onSelect: (panel: Panel) => void;
	/** Uncommitted files, for the badge. */
	uncommitted: number;
	onSettings: () => void;
	/** Full build string. Displayed short, but kept whole in the tooltip. */
	version: string;
}) {
	return (
		<nav
			aria-label="Panels"
			className="flex w-11 shrink-0 flex-col items-center border-r border-neutral-800 bg-neutral-950"
		>
			<RailButton
				label={panel === "editor" ? "Hide editor" : "Show editor"}
				title={panel === "editor" ? "Hide editor" : "Browse and edit the project's files"}
				active={panel === "editor"}
				onClick={() => onSelect("editor")}
			>
				<Code size={20} />
			</RailButton>

			<RailButton
				label={panel === "review" ? "Hide source control" : "Show source control"}
				title={
					panel === "review"
						? "Hide source control"
						: "Changes, commits and the commit message"
				}
				active={panel === "review"}
				badge={uncommitted}
				onClick={() => onSelect("review")}
			>
				<GitBranch size={20} />
			</RailButton>

			<RailButton
				label={panel === "terminal" ? "Hide terminal" : "Show terminal"}
				title={
					panel === "terminal"
						? "Hide terminal (Ctrl+`) — the shell keeps running"
						: "Show terminal (Ctrl+`)"
				}
				active={panel === "terminal"}
				onClick={() => onSelect("terminal")}
			>
				<TerminalWindow size={20} />
			</RailButton>

			<RailButton
				label={panel === "packages" ? "Hide packages" : "Show packages"}
				title="Packages installed on this machine"
				active={panel === "packages"}
				onClick={() => onSelect("packages")}
			>
				<SquaresFour size={20} />
			</RailButton>

			{/* `mt-auto` on the first of the bottom pair is what pushes both down:
			    settings is the conventional resting place down there, and the
			    version under it is what you read out loud when two machines
			    disagree about what they are running. */}
			<div className="mt-auto flex flex-col items-center">
				<RailButton label="Settings" title="Settings" onClick={onSettings}>
					<Gear size={20} />
				</RailButton>

			{/*
			 * Just the release number, because 11px of rail is all there is. The
			 * commit and the dirty marker are not dropped, only moved into the
			 * tooltip — they are exactly what you need when two machines both
			 * claim 0.1.0, so losing them to fit would defeat showing a version
			 * at all.
			 */}
				<p
					title={`Version ${version} — version + git commit; * means uncommitted changes`}
					className="pb-1.5 text-caption leading-none text-neutral-600"
				>
					{version.split("+")[0]}
				</p>
			</div>
		</nav>
	);
}
