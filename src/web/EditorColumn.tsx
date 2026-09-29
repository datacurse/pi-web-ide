import { useState } from "react";
import { Plus, TerminalWindow } from "@phosphor-icons/react";
import type { PiSessionInfo } from "../shared/types.js";
import type { Hunk } from "../shared/hunks.js";
import { SessionTabs, tabDomId } from "./SessionTabs.js";
import { Terminal } from "./Terminal.js";
import { DiffView } from "./DiffView.js";
import { FileEditor } from "./FileEditor.js";
import { diffParts, isDiffTab, isFileTab, isTermTab, termId, tabPath } from "./tabs.js";
import type { Side, TabGroup } from "./tabs.js";
import { SplitZone } from "./SplitZone.js";
import { type Attention } from "./attention.js";
import { ContextMenu, MenuItem } from "./ui.js";
import { t } from "./i18n.js";

/**
 * One editor column: a tab strip, and whatever its selected tab shows.
 *
 * Both halves of the split are this SAME component, which is what makes them
 * symmetric — the same strip, the same drop targets, the same rules — rather
 * than a real editor and a lesser copy of one.
 *
 * `chat` is passed in as an element: each column's chat is wired to that
 * column's own session hook (see `useSession`).
 */
export function EditorColumn({
	side,
	group,
	panelId,
	sessions,
	attention,
	shortNames,
	pinned,
	dirtyFiles,
	onSelect,
	onClose,
	onReorder,
	onMove,
	onFocus,
	listOpen,
	onToggleList,
	cwd,
	onDirty,
	sessionId,
	hunks,
	onHunksChanged,
	chat,
	focused,
	onReveal,
	onTogglePin,
	onRename,
	onNewSession,
	onNewTerminal,
}: {
	side: Side;
	group: TabGroup;
	panelId: string;
	sessions: PiSessionInfo[];
	attention: Map<string, Attention>;
	shortNames: boolean;
	pinned: string[];
	dirtyFiles: Record<string, boolean>;
	onSelect: (entry: string) => void;
	onClose: (entry: string) => void;
	onReorder: (from: number, to: number) => void;
	onMove: (entry: string, to: Side, index?: number) => void;
	/** This column was interacted with; it becomes the one new tabs open in. */
	onFocus: () => void;
	listOpen?: boolean;
	onToggleList?: () => void;
	cwd: string;
	onDirty: (path: string, dirty: boolean) => void;
	/** The attached session, for hunk decisions inside a working-tree diff. */
	sessionId?: string;
	hunks: Hunk[];
	onHunksChanged: () => void;
	/** This column's chat, or null when the column holds no session. */
	chat: React.ReactNode;
	/** In a split, whether this is the column keys and new tabs go to. */
	focused: boolean;
	/** Show a file tab's file in the Explorer. */
	onReveal: (path: string) => void;
	onTogglePin: (file: string) => void;
	onRename: (session: PiSessionInfo, name: string) => void;
	/** For the chat's right-click menu; both open in this column. */
	onNewSession: () => void;
	/** Absent without a project: a shell has to start somewhere. */
	onNewTerminal?: () => void;
}) {
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
	const active = group.active;
	const activeIndex = active ? group.files.indexOf(active) : -1;
	const showsFile = active !== undefined && isFileTab(active);
	const showsDiff = active !== undefined && isDiffTab(active);
	const showsTerm = active !== undefined && isTermTab(active);
	/** The chat hides under a file, a diff or a terminal. */
	const showsDoc = showsFile || showsDiff || showsTerm;

	return (
		<div
			// Capture, so a click anywhere in the column counts — including on a
			// tab, whose own handler stops nothing but runs first.
			onFocusCapture={onFocus}
			onPointerDownCapture={onFocus}
			className={`flex min-h-0 min-w-0 flex-1 flex-col ${
				/* Only the second column draws the seam, so an unsplit editor has no
				   stray border down its left edge. Hidden on a phone, where two
				   columns is a handful of words per line each — the state is
				   untouched, so the tabs return when the window widens. */
				side === "right" ? "border-l border-neutral-800 narrow:hidden" : ""
			}`}
		>
			<SessionTabs
				tabs={group.files}
				sessions={sessions}
				attention={attention}
				active={active}
				panelId={panelId}
				label={side === "left" ? t("Open sessions") : t("Open sessions, second column")}
				listOpen={listOpen}
				onSelect={onSelect}
				onClose={onClose}
				onToggleList={onToggleList}
				shortNames={shortNames}
				pinned={pinned}
				focused={focused}
				dirtyFiles={dirtyFiles}
				onReorder={onReorder}
				// A tab dropped on THIS strip belongs in THIS column, at the slot it
				// was aimed at.
				onAdopt={(entry, index) => onMove(entry, side, index)}
				onReveal={onReveal}
				onTogglePin={onTogglePin}
				onRename={onRename}
			/>
			<SplitZone
				/*
				 * The left column's halves mean "keep it here" and "put it in the
				 * second column". The right column is already the rightmost, so both
				 * of its halves mean the same thing: there is nothing further right
				 * to create, and honouring a left-half drop here would yank the tab
				 * back out of the column you just aimed at.
				 */
				onDrop={(entry, dropSide) => onMove(entry, side === "right" ? side : dropSide)}
				// ...and the highlight says so: one target covering the whole body,
				// rather than a half promising a third column.
				splits={side === "left"}
				className="flex min-h-0 min-w-0 flex-1 flex-col"
			>
				<div
					id={panelId}
					role="tabpanel"
					aria-labelledby={activeIndex >= 0 ? tabDomId(activeIndex) : undefined}
					onContextMenu={(e) => {
						// Only over the chat or an empty column, and the browser keeps its
						// own menu wherever it is the useful one: selected text, links,
						// images, the composer, and Shift+right-click anywhere. Buttons and
						// the whole box under the transcript (git, jump-to-latest) get none.
						if (showsDoc || e.shiftKey) return;
						if ((e.target as Element).closest("a, img, button, input, textarea, select, [contenteditable], [data-no-column-menu]")) return;
						if (window.getSelection()?.toString()) return;
						e.preventDefault();
						setMenu({ x: e.clientX, y: e.clientY });
					}}
					className="flex min-h-0 min-w-0 flex-1 flex-col"
				>
					{showsFile && (
						<FileEditor
							// Keyed by path: switching files must build a new editor rather
							// than reuse one holding another file's undo history.
							key={active}
							path={tabPath(active)}
							cwd={cwd}
							onDirty={onDirty}
						/>
					)}
					{showsDiff && (
						<DiffView
							// Same rule as the editor: a merge view is built around its two
							// documents and cannot be repointed at another file.
							key={active}
							path={diffParts(active).path}
							refName={diffParts(active).ref}
							cwd={cwd}
							sessionId={sessionId}
							// Only this file's hunks: the pane shows one file, and the
							// others' decisions belong to their own tabs.
							hunks={hunks.filter((h) => h.path === diffParts(active).path)}
							onChanged={onHunksChanged}
						/>
					)}
					{/* Mounted only while showing, like the dock: the server replays the
					    scrollback on attach, and a hidden xterm cannot measure itself. */}
					{showsTerm && <Terminal key={active} id={termId(active)} focused />}
					{/*
					 * The chat stays MOUNTED under a file tab rather than being swapped
					 * out: it holds the live EventSource and the transcript's scroll
					 * position, so unmounting to look at a file would drop a streaming
					 * turn and lose your place in it. `hidden` costs a hidden subtree;
					 * remounting costs the session.
					 */}
					{chat && (
						<div
							className={`flex min-h-0 min-w-0 flex-1 flex-col ${showsDoc ? "hidden" : ""}`}
						>
							{chat}
						</div>
					)}
					{/* Nothing to show: an empty column says so rather than going blank. */}
					{!showsDoc && !chat && (
						<p className="m-auto px-4 text-center text-ui text-neutral-500">
							{t("Drag a tab here, or pick one above.")}
						</p>
					)}
				</div>
			</SplitZone>
			{menu && (
				<ContextMenu x={menu.x} y={menu.y} label={t("New tab")} onClose={() => setMenu(null)}>
					<MenuItem
						icon={<Plus size={16} />}
						role="menuitem"
						autoFocus
						onClick={() => {
							setMenu(null);
							onNewSession();
						}}
					>
						{t("New AI Session")}
					</MenuItem>
					<MenuItem
						icon={<TerminalWindow size={16} />}
						role="menuitem"
						disabled={!onNewTerminal}
						onClick={() => {
							setMenu(null);
							onNewTerminal?.();
						}}
					>
						{t("New Terminal Tab")}
					</MenuItem>
				</ContextMenu>
			)}
		</div>
	);
}
