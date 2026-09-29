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
 * Only Explorer and Source Control are panels. The terminal toggles a dock
 * under the editor columns, and Stats, Packages and Settings open as tabs.
 */

import type { ReactNode } from "react";
import { ChartBar, Code, GitBranch, Gear, Network, SquaresFour, TerminalWindow } from "@phosphor-icons/react";
import type { Panel } from "./App.js";
import type { PageId } from "./PageDialog.js";
import { t, plural } from "./i18n.js";

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
			className={`relative flex size-11 shrink-0 items-center justify-center transition-colors duration-150 ease-out hover:text-neutral-50 motion-reduce:transition-none ${
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
					<span className="sr-only">, {plural(badge, "{n} uncommitted file", "{n} uncommitted files")}</span>
				</>
			)}
		</button>
	);
}

export function ActivityBar({
	panel,
	onSelect,
	uncommitted,
	dockOpen,
	onToggleDock,
	onPage,
	version,
}: {
	/** The panel showing now, or null when the chat has the whole width. */
	panel: Panel;
	/** Show this panel — or close it, when it is already the one showing. */
	onSelect: (panel: Panel) => void;
	/** Uncommitted files, for the badge. */
	uncommitted: number;
	/** The terminal dock under the editor columns. */
	dockOpen: boolean;
	onToggleDock: () => void;
	/** Open a page in the page dialog. */
	onPage: (page: PageId) => void;
	/** Full build string. Displayed short, but kept whole in the tooltip. */
	version: string;
}) {
	const page = (id: PageId, label: string, title: string, icon: ReactNode) => (
		<RailButton label={label} title={title} onClick={() => onPage(id)}>
			{icon}
		</RailButton>
	);
	return (
		<nav
			aria-label={t("Panels")}
			className="flex w-11 shrink-0 flex-col items-center border-r border-neutral-800 bg-neutral-950"
		>
			<RailButton
				label={panel === "editor" ? t("Hide editor") : t("Show editor")}
				title={panel === "editor" ? t("Hide editor") : t("Browse and edit the project's files")}
				active={panel === "editor"}
				onClick={() => onSelect("editor")}
			>
				<Code size={20} />
			</RailButton>

			<RailButton
				label={panel === "review" ? t("Hide source control") : t("Show source control")}
				title={
					panel === "review"
						? t("Hide source control")
						: t("Changes, commits and the commit message")
				}
				active={panel === "review"}
				badge={uncommitted}
				onClick={() => onSelect("review")}
			>
				<GitBranch size={20} />
			</RailButton>

			{/* Set apart from the panels above: it toggles the dock under the
			    tabs, not the left column. */}
			<div aria-hidden className="my-1 w-full border-t border-neutral-800" />
			<RailButton
				label={dockOpen ? t("Hide terminal") : t("Show terminal")}
				title={dockOpen ? t("Hide terminal (Ctrl+`) — the shells keep running") : t("Show terminal (Ctrl+`)")}
				active={dockOpen}
				onClick={onToggleDock}
			>
				<TerminalWindow size={20} />
			</RailButton>

			{/* Pages open in a modal. `mt-auto` pushes the group to the bottom. */}
			<div className="mt-auto flex flex-col items-center">
				{page("fleet", t("Fleet"), t("Your tailnet machines: pwi links, terminals, Start"), <Network size={20} />)}
				{page("stats", t("Stats"), t("Usage stats: streaks, answer times, every answer"), <ChartBar size={20} />)}
				{page("packages", t("Packages"), t("Packages installed on this machine"), <SquaresFour size={20} />)}
				{page("settings", t("Settings"), t("Settings"), <Gear size={20} />)}

			{/*
			 * Just the release number, because 11px of rail is all there is. The
			 * commit and the dirty marker are not dropped, only moved into the
			 * tooltip — they are exactly what you need when two machines both
			 * claim v112, so losing them to fit would defeat showing a version
			 * at all.
			 */}
				<p
					title={t("Version {version} — version + git commit; * means uncommitted changes", { version })}
					className="pb-1.5 text-caption leading-none text-neutral-600"
				>
					{version.split("+")[0]}
				</p>
			</div>
		</nav>
	);
}
