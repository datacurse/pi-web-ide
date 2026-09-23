/**
 * tabs.ts — what an entry in the tab strip is.
 *
 * One strip holds both chat sessions and open files, the way VS Code's does.
 * An entry is a plain string so the whole existing apparatus — persistence
 * under `pwi:tabs:<project>`, Alt+1..9, close-and-select-the-neighbour — keeps
 * working on one list instead of growing a parallel one per kind.
 *
 * A file entry is its absolute path behind a `file:` prefix. Sessions are
 * absolute paths to a `.jsonl`, which start with `/` (or a drive letter), so
 * the two can never be confused for one another.
 */

const FILE_PREFIX = "file:";

/** The tab entry for an open file. */
export const fileTab = (path: string): string => `${FILE_PREFIX}${path}`;

/** True when this entry is a file rather than a chat session. */
export const isFileTab = (entry: string): boolean => entry.startsWith(FILE_PREFIX);

/** The absolute path inside a file entry. Meaningless for a session entry. */
export const tabPath = (entry: string): string => entry.slice(FILE_PREFIX.length);

/** The name a file tab shows: its basename, or the whole path if it has none. */
export const tabLabel = (entry: string): string => {
	const path = tabPath(entry);
	return path.split("/").pop() || path;
};

/**
 * One editor column: its tabs, and which of them is showing.
 *
 * The split is TWO of these and not a list of N, because two is the layout
 * people actually use — a file beside the thing it is about. N columns is a
 * resizable tree of splits, which is a different feature.
 */
export interface TabGroup {
	files: string[];
	active?: string;
}

/** Which editor column. The split has exactly two; see TabGroup. */
export type Side = "left" | "right";

/**
 * The two columns, as stored.
 *
 * The left one is flattened into `files`/`active` rather than nested, because
 * that is the shape already persisted under `pwi:tabs:<project>` — nesting it
 * would drop every remembered tab on upgrade, to no benefit.
 */
export interface TabState {
	files: string[];
	active?: string;
	/** Undefined means unsplit; an empty group cannot occur (see `withGroup`). */
	right?: TabGroup;
}

/** One column's tabs, whichever half it is. */
export function groupOf<T extends TabState>(tabs: T, side: Side): TabGroup {
	return side === "left"
		? { files: tabs.files, active: tabs.active }
		: (tabs.right ?? { files: [] });
}

/**
 * `tabs` with one column replaced.
 *
 * An emptied SECOND column collapses the split, because a column with no tabs
 * is a divider and a blank pane. An emptied first column stays: it owns the
 * "no open sessions" hint, and a layout with no first column would have
 * nowhere to put a tab back.
 */
export function withGroup<T extends TabState>(tabs: T, side: Side, group: TabGroup): T {
	return side === "left"
		? { ...tabs, files: group.files, active: group.active }
		: { ...tabs, right: group.files.length > 0 ? group : undefined };
}

/**
 * The group with `file` gone, and the selection moved off it if it was the
 * one showing.
 *
 * The replacement is the tab that SLID INTO the closed one's slot, so closing
 * the rightmost tab lands on its left neighbour instead of on the empty pane.
 * Returns null when the group does not have the file, which is how a caller
 * tells "nothing to do" from "removed the last tab" — the latter returns a
 * group with no active tab, and those two need different handling upstream.
 *
 * Shared by closing a tab and by dragging one into the other column: they are
 * the same removal, and getting the neighbour rule right in only one of them
 * is how the two drift apart.
 */
export function withoutTab(group: TabGroup, file: string): TabGroup | null {
	const index = group.files.indexOf(file);
	if (index < 0) return null;
	const files = group.files.filter((f) => f !== file);
	return {
		files,
		active: group.active === file ? files[Math.min(index, files.length - 1)] : group.active,
	};
}

/**
 * The group with `file` showing, appended if it is not already open.
 *
 * Idempotent on purpose: dropping a tab onto the column it is already in, or
 * opening a file twice from the tree, must focus the one tab rather than
 * growing a duplicate.
 */
export function withTab(group: TabGroup, file: string): TabGroup {
	return {
		files: group.files.includes(file) ? group.files : [...group.files, file],
		active: file,
	};
}

/**
 * The strip with the tab at `from` moved to index `to`.
 *
 * An out-of-range index returns the list UNCHANGED rather than throwing: the
 * caller is a drag handler, and an index from a strip that changed mid-gesture
 * (a session closing itself, the project switching) should be a no-op, not a
 * crash or a tab teleported to the end.
 */
export function moveTab(files: string[], from: number, to: number): string[] {
	if (from === to) return files;
	if (from < 0 || from >= files.length || to < 0 || to >= files.length) return files;
	const next = [...files];
	const [moved] = next.splice(from, 1);
	if (moved === undefined) return files;
	next.splice(to, 0, moved);
	return next;
}
