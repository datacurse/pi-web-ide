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
