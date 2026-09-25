/**
 * files.ts — reading, listing and writing the project's files: the editor's
 * backend, and the diff tabs'.
 *
 * This is the one module in the server that writes to arbitrary paths on
 * behalf of the browser, so the path check here is a TRUST BOUNDARY and not a
 * tidiness rule. Everything else that takes a path from the client (projects,
 * favourites, browse) only ever reads a directory listing; a bug there shows
 * you a folder you did not ask for, a bug here overwrites a file outside the
 * project. The two are not the same risk and this module is written for the
 * second one.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { listProjects } from "./projects.js";
import type { PiwFileEntry } from "../shared/types.js";

/**
 * Files above this are not reviewed, they are refused.
 *
 * The pane renders a full before/after in the browser, and a hunk carries both
 * sides of its text; a 200MB log an agent touched would be sent twice over SSE
 * and then diffed in a tab. The number is generous for source and hostile to
 * everything else.
 */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Directories the editor tree never walks into.
 *
 * Skipped at the DIRECTORY level rather than filtered out of the results,
 * because the cost is the readdir itself: `node_modules` in a pnpm project is
 * a six-figure number of entries, and expanding it once would stall the pane
 * for seconds to build a list nobody scrolls.
 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache", "coverage"]);

/** `~` arrives from hand-typed and pasted paths the same way it does in projects.ts. */
function expand(path: string): string {
	const raw = path.trim();
	return resolve(raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw);
}

/**
 * True when `path` is inside `root` — by path SEGMENTS, not by prefix.
 *
 * `startsWith` is the classic hole here: `/home/me/proj-secrets` starts with
 * `/home/me/proj` and is a different directory. `relative()` answers the
 * actual question, and the `..` check is what rejects an escape.
 *
 * The absolute check is not redundant: when there is no relative route at all
 * between the two — different drives on Windows — `relative()` returns an
 * absolute path, which contains no `..` and would otherwise read as contained.
 */
function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Resolve a client-supplied path to something safe to touch, or throw.
 *
 * Containment is to the projects this server knows about, because that is the
 * only definition of "in scope" it has: a session runs in a cwd, and the agent
 * edits under it. A path outside every project is refused rather than
 * clamped — silently redirecting a write is worse than failing it.
 *
 * `seed` is the server's startup cwd, which `listProjects` always includes.
 */
export function safePath(seed: string, path: string): string {
	if (typeof path !== "string" || path.trim() === "") throw new Error("path required");
	// Resolve FIRST, then check: `/home/me/proj/../../etc/passwd` is only
	// visible as an escape once it is normalised.
	const full = expand(path);
	const roots = listProjects(seed).map(expand);
	if (!roots.some((root) => within(root, full))) {
		throw new Error(`path is outside every known project: ${full}`);
	}
	return full;
}

/** A file's current contents, or null when it does not exist. */
export function readFile(seed: string, path: string): string | null {
	const full = safePath(seed, path);
	let st;
	try {
		st = statSync(full);
	} catch {
		// Absent is a normal answer here: the agent may have created a file the
		// user then deleted, and the pane has to render that rather than 500.
		return null;
	}
	if (!st.isFile()) throw new Error(`not a file: ${full}`);
	if (st.size > MAX_BYTES) throw new Error(`file too large to review: ${full} (${st.size} bytes)`);
	return readFileSync(full, "utf8");
}

/**
 * One directory's children for the file tree: files AND directories, which is
 * what separates this from `browse()` in projects.ts — that one feeds the
 * project picker, where a file can never be the answer.
 *
 * One level per call. A recursive walk would be one request instead of many,
 * and would also read an entire repo to render a sidebar showing twelve rows.
 */
export function listDir(seed: string, path: string): PiwFileEntry[] {
	const dir = safePath(seed, path);
	if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);

	const out: PiwFileEntry[] = [];
	for (const child of readdirSync(dir, { withFileTypes: true })) {
		if (SKIP_DIRS.has(child.name)) continue;
		// withFileTypes avoids a stat per child. A symlink is the one dirent whose
		// kind readdir cannot answer, and its target may be missing or unreadable.
		let isDir = child.isDirectory();
		if (child.isSymbolicLink()) {
			try {
				isDir = statSync(join(dir, child.name)).isDirectory();
			} catch {
				continue;
			}
		} else if (!isDir && !child.isFile()) {
			// Sockets, FIFOs and devices are neither editable nor browsable.
			continue;
		}
		out.push({
			name: child.name,
			path: join(dir, child.name),
			dir: isDir,
			hidden: child.name.startsWith("."),
		});
	}
	// Directories first, dotted names last within each group: a plain sort would
	// put .env and .gitignore above every file you came here to open.
	out.sort(
		(a, b) =>
			Number(b.dir) - Number(a.dir) ||
			Number(a.hidden) - Number(b.hidden) ||
			a.name.localeCompare(b.name, undefined, { numeric: true }),
	);
	return out;
}

/**
 * Write a file the USER edited.
 *
 * Same concurrency check as the hunk-revert write and for the same reason —
 * the agent edits these files too, and this server is the only thing that sees
 * both writers. `expect` is what the editor had when it loaded the buffer; a
 * mismatch means the agent (or another tab) saved underneath, and the honest
 * answer is to refuse and let the UI offer a reload rather than silently
 * discard the other write.
 *
 * Content comparison, not mtime/inode. Costs a read per save, which
 * is nothing next to the round trip; revisit if saves ever get chatty.
 */
export function writeFile(seed: string, path: string, expect: string, next: string): void {
	const full = safePath(seed, path);
	const current = readFile(seed, full);
	// A new file is expected to be absent, which `expect: ""` says.
	if ((current ?? "") !== expect) throw new Error(`file changed on disk since it was opened: ${full}`);
	if (next === current) return;
	writeFileSync(full, next, "utf8");
}

/**
 * Write reviewed contents back.
 *
 * `expect` is the caller's idea of what is currently on disk, and this refuses
 * when it does not match. That check is the whole point: the pane computes the
 * new contents from a file it read some time ago, and between the read and
 * this write the agent may have run again or the user may have saved in their
 * own editor. Without it, resolving a hunk would silently discard whatever
 * landed in between.
 */
export function writeReviewed(seed: string, path: string, expect: string, next: string): void {
	const full = safePath(seed, path);
	const current = readFile(seed, full) ?? "";
	if (current !== expect) throw new Error(`file changed on disk since it was read: ${full}`);
	if (next === current) return;
	writeFileSync(full, next, "utf8");
}
