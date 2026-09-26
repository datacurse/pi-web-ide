/**
 * tabs.ts — what an entry in the tab strip is.
 *
 * One strip holds both chat sessions and open files, the way VS Code's does.
 * An entry is a plain string so the whole existing apparatus — persistence
 * under `pwi:tabs:<project>`, Alt+1..9, close-and-select-the-neighbour — keeps
 * working on one list instead of growing a parallel one per kind.
 *
 * A file entry is its absolute path behind a `file:` prefix, a diff entry is
 * `diff:<ref>:<path>`. Sessions are absolute paths to a `.jsonl`, which start
 * with `/` (or a drive letter), so the three can never be confused for one
 * another.
 *
 * `isSessionTab` and not `!isFileTab` is the rule every caller follows, and
 * the reason this file has three predicates rather than one: App ATTACHES to
 * anything it believes is a session, so a diff entry that merely fails the
 * file test would be handed to the EventSource as a session path.
 */

const FILE_PREFIX = "file:";
const DIFF_PREFIX = "diff:";

/** The tab entry for an open file. */
export const fileTab = (path: string): string => `${FILE_PREFIX}${path}`;

/** True when this entry is a file rather than a chat session or a diff. */
export const isFileTab = (entry: string): boolean => entry.startsWith(FILE_PREFIX);

/**
 * The tab entry for one file's diff. `ref` is a commit sha, or "" for the
 * working tree — the same two cases `/api/git/show` takes.
 */
export const diffTab = (ref: string, path: string): string => `${DIFF_PREFIX}${ref}:${path}`;

/** True when this entry is a diff view rather than an editable file. */
export const isDiffTab = (entry: string): boolean => entry.startsWith(DIFF_PREFIX);

/**
 * The commit and path inside a diff entry.
 *
 * Split at the FIRST colon after the prefix: a sha never contains one, and a
 * path legitimately can.
 */
export function diffParts(entry: string): { ref: string; path: string } {
	const rest = entry.slice(DIFF_PREFIX.length);
	const cut = rest.indexOf(":");
	return cut < 0 ? { ref: "", path: rest } : { ref: rest.slice(0, cut), path: rest.slice(cut + 1) };
}

/** True when this entry is a chat session: the only kind App attaches to. */
export const isSessionTab = (entry: string): boolean => !isFileTab(entry) && !isDiffTab(entry);

/** The absolute path inside a file or diff entry. Meaningless for a session. */
export const tabPath = (entry: string): string =>
	isDiffTab(entry) ? diffParts(entry).path : entry.slice(FILE_PREFIX.length);

/**
 * The name a tab shows: its basename, or the whole path if it has none.
 *
 * A diff carries its commit in the label, because "App.tsx" open twice — once
 * as it is now and once as it was three commits ago — is otherwise two
 * identical tabs.
 */
export const tabLabel = (entry: string): string => {
	const path = tabPath(entry);
	const name = path.split("/").pop() || path;
	if (!isDiffTab(entry)) return name;
	const { ref } = diffParts(entry);
	return ref ? `${name} (${ref.slice(0, 7)})` : `${name} ↔ working tree`;
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
 * Which column an entry is already open in, or null.
 *
 * The rule every caller that adds a tab has to follow first, because adding
 * one that is already open in the OTHER column is how a session ends up in
 * both — and the chat can only render in one of them, so the other copy is a
 * tab you can select and then stare at an empty pane.
 *
 * `alt` is a second key for the same tab: a session with no JSONL yet is
 * keyed by its id until the file exists, and the two must not be treated as
 * different tabs.
 */
export function sideOfTab<T extends TabState>(
	tabs: T,
	entry: string,
	alt?: string,
): Side | null {
	const has = (files: string[]) => files.some((f) => f === entry || (alt !== undefined && f === alt));
	if (has(tabs.right?.files ?? [])) return "right";
	return has(tabs.files) ? "left" : null;
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
 * `tabs` with an emptied FIRST column filled by the second, which then closes.
 *
 * The mirror of `withGroup`'s rule for the right column: one empty column is a
 * divider and a blank pane either way. Closing the last tab on the left used to
 * leave that pane sitting beside a perfectly full second column.
 *
 * Applied once where tabs are committed rather than inside `withGroup`, because
 * a move between columns writes BOTH columns and a mid-move collapse would copy
 * the right column's tabs into the left before the second write lands.
 */
export function collapse<T extends TabState>(tabs: T): T {
	if (tabs.files.length > 0 || !tabs.right) return tabs;
	return { ...tabs, files: tabs.right.files, active: tabs.right.active, right: undefined };
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

/** The strip with pinned entries moved to the front, each group keeping its order. */
export function pinnedFirst(files: string[], pinned: readonly string[]): string[] {
	const front = files.filter((f) => pinned.includes(f));
	return front.length === 0 ? files : [...front, ...files.filter((f) => !pinned.includes(f))];
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

/**
 * The tabs after a file or folder at `from` was renamed to `to`, or deleted
 * when `to` is null. File tabs at or under `from` follow it or close; diff
 * tabs are left alone, because they show git's history of a path, not a file.
 */
export function afterPathChange<T extends TabState>(tabs: T, from: string, to: string | null): T {
	const hit = (e: string) => {
		if (!isFileTab(e)) return false;
		const p = tabPath(e);
		return p === from || p.startsWith(`${from}/`);
	};
	const moved = (e: string) => fileTab(`${to}${tabPath(e).slice(from.length)}`);
	const fix = (group: TabGroup): TabGroup => {
		if (to !== null) {
			return {
				files: group.files.map((e) => (hit(e) ? moved(e) : e)),
				active: group.active && hit(group.active) ? moved(group.active) : group.active,
			};
		}
		// One at a time through withoutTab, so the selection lands on a neighbour.
		let g = group;
		for (const e of group.files) if (hit(e)) g = withoutTab(g, e) ?? g;
		return g;
	};
	const next = withGroup(tabs, "left", fix(groupOf(tabs, "left")));
	return tabs.right ? withGroup(next, "right", fix(tabs.right)) : next;
}
