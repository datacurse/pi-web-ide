/**
 * projects.ts — the directories piw knows about: the ones whose sessions it
 * shows, the ones pinned in the picker, and the listing that feeds the picker.
 *
 * A "project" is just a cwd. pi already stores sessions per working directory
 * (~/.pi/agent/sessions/<encoded-cwd>/) and each session header carries `cwd`,
 * so there is nothing to model here beyond remembering which directories the
 * user cares about. A flat JSON array in this server's state directory is the
 * whole store, and favourites are a second array of exactly the same shape.
 *
 * Both lists are inherited once from an omp-era install if this one has none:
 * they are just paths, they are equally true for either product, and retyping
 * a dozen project directories is a pointless tax. See state.ts.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { legacyPath, readStateFile, statePath, writeStateFile } from "./state.js";
import type { PiwDirEntry, PiwDirListing } from "../shared/types.js";

const PROJECTS = "projects.json";
/**
 * Pinned directories for the picker. Server-side and not `localStorage`
 * because these are paths on THIS machine: the browser may be reaching piw
 * through an ssh forward, where a per-origin copy would be the wrong
 * machine's folders — and a second piw port on the same host would silently
 * have its own set.
 */
const FAVORITES = "favorites.json";

/** What the omp-era install called the same two lists. */
const LEGACY: Record<string, string> = {
	[PROJECTS]: "piw-projects.json",
	[FAVORITES]: "piw-favorites.json",
};

/** A stored flat array of paths, or nothing when the file is absent or corrupt. */
function read(name: string): string[] | null {
	const text = readStateFile(statePath(name), legacyPath(LEGACY[name]));
	if (text === undefined) return null;
	try {
		const raw: unknown = JSON.parse(text);
		if (!Array.isArray(raw)) return null;
		return raw.filter((p): p is string => typeof p === "string");
	} catch {
		// A corrupt file is not an error: it just means "nothing stored here
		// yet". Overwriting it on the next add is the only sane recovery.
		return null;
	}
}

/** `~` is typed by hand, pasted, and sent by the picker, so expand it once. */
function expand(path: string): string {
	const raw = path.trim();
	return resolve(raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw);
}

function requireDir(path: string): string {
	const dir = expand(path);
	if (!existsSync(dir) || !statSync(dir).isDirectory())
		throw new Error(`not a directory: ${dir}`);
	return dir;
}

export function listProjects(seed: string): string[] {
	const stored = read(PROJECTS) ?? [];
	// The startup cwd is always present — piw launched against a directory must
	// be able to show that directory's sessions without an explicit add.
	return stored.includes(seed) ? stored : [seed, ...stored];
}

/**
 * Add a directory. The path arrives from the browser, so it is validated here
 * rather than trusted: a nonexistent or non-directory cwd would otherwise make
 * pi create a session directory for a typo.
 */
export function addProject(seed: string, path: string): string[] {
	const dir = requireDir(path);
	const next = listProjects(seed);
	if (!next.includes(dir)) next.push(dir);
	save(PROJECTS, next);
	return next;
}

/**
 * Pinned directories, in the order they were pinned.
 *
 * Separate from the project list on purpose: a favourite is a place you
 * BROWSE from — `~/code`, a drive mount — and is usually not a project
 * itself, while a project is a cwd whose sessions are listed. Conflating
 * them would either pollute the project dropdown with parent directories or
 * make every shortcut cost a session poll.
 */
export function listFavorites(): string[] {
	return read(FAVORITES) ?? [];
}

export function addFavorite(path: string): string[] {
	const dir = requireDir(path);
	const next = listFavorites();
	if (!next.includes(dir)) next.push(dir);
	save(FAVORITES, next);
	return next;
}

/**
 * Unpin. No existence check: a favourite whose directory was deleted is
 * exactly the one you most need to be able to remove.
 */
export function removeFavorite(path: string): string[] {
	const next = listFavorites().filter((p) => p !== expand(path));
	save(FAVORITES, next);
	return next;
}

/**
 * One directory's subdirectories, for the picker that feeds addProject.
 *
 * This exists because the browser cannot enumerate the server's filesystem,
 * and typing an absolute path from memory is the worst part of adding a
 * project. It is deliberately not sandboxed to any root: piw binds loopback
 * only and its agents already run tools against this machine, so a directory
 * listing grants nothing that is not already on offer. Directories only —
 * files cannot be projects.
 */
export function browse(path: string): PiwDirListing {
	const dir = expand(path.trim() || homedir());
	if (!statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);

	const entries: PiwDirEntry[] = [];
	for (const child of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, child.name);
		// withFileTypes to avoid a stat per child. A symlink is the one dirent
		// whose kind readdir cannot answer, so only those are stat'd — and its
		// target may be missing or unreadable, which is not a directory either.
		if (!child.isDirectory()) {
			if (!child.isSymbolicLink()) continue;
			try {
				if (!statSync(full).isDirectory()) continue;
			} catch {
				continue;
			}
		}
		entries.push({
			name: child.name,
			path: full,
			repo: existsSync(join(full, ".git")),
			hidden: child.name.startsWith("."),
		});
	}
	// Dotted names last instead of hidden: an ASCII sort would otherwise put
	// ~/.cache above every directory you actually came here to click.
	entries.sort(
		(a, b) =>
			Number(a.hidden) - Number(b.hidden) ||
			a.name.localeCompare(b.name, undefined, { numeric: true }),
	);

	// `dirname("/") === "/"`, which is how the root announces it has no parent.
	const parent = dirname(dir);
	return {
		path: dir,
		parent: parent === dir ? null : parent,
		home: homedir(),
		entries,
	};
}

/** Remove a directory from the list. Sessions on disk are untouched. */
export function removeProject(seed: string, path: string): string[] {
	const next = listProjects(seed).filter((p) => p !== path);
	save(PROJECTS, next);
	return next;
}

function save(name: string, paths: string[]): void {
	writeStateFile(statePath(name), JSON.stringify(paths, null, "\t"), 0o644);
}
