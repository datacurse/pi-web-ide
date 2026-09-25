/**
 * state.ts — where this server keeps the things only it knows.
 *
 * Everything persistent that is pi-web-ide's rather than pi's lives in one
 * directory: the project list, favourites and the personality text. Not under
 * `~/.pi/agent/`, which is pi's own store and not ours to litter.
 *
 * `PWI_STATE_DIR` overrides it, which is also the seam the tests point at a
 * temp directory. Resolved per call rather than captured at import, so an env
 * var set after this module first loads still takes effect.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
	return process.env.PWI_STATE_DIR ?? join(homedir(), ".config", "pi-web-ide");
}

export function statePath(name: string): string {
	return join(stateDir(), name);
}

/**
 * Replace a state file atomically.
 *
 * Written to a sibling temp file and renamed, because `writeFileSync`
 * truncates first: a crash or a full disk mid-write would otherwise leave
 * half a project list — or half a personality — on disk. rename(2) within one
 * directory is atomic.
 */
export function writeStateFile(path: string, text: string, mode = 0o600): void {
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text, { mode });
	renameSync(tmp, path);
}

/** A state file's text, or undefined when it is absent or unreadable. */
export function readStateFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}
