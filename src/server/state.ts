/**
 * state.ts — where this server keeps the things only it knows.
 *
 * Everything persistent that is pi-web-ide's rather than pi's lives in one
 * directory: the machine list, the project list, favourites, the personality
 * text, and later the packages manifest. Not under `~/.pi/agent/`, which is
 * pi's own store and not ours to litter — the old install did exactly that
 * and left `piw-hosts.json` sitting next to an agent's credentials.
 *
 * `PIW_STATE_DIR` overrides it, which is also the seam the tests point at a
 * temp directory. Resolved per call rather than captured at import, so an env
 * var set after this module first loads still takes effect.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function stateDir(): string {
	return process.env.PIW_STATE_DIR ?? join(homedir(), ".config", "pi-web-ide");
}

export function statePath(name: string): string {
	return join(stateDir(), name);
}

/**
 * Replace a state file atomically.
 *
 * Written to a sibling temp file and renamed, because `writeFileSync`
 * truncates first: a crash or a full disk mid-write would otherwise leave
 * half a hosts list — or half a personality — on disk. rename(2) within one
 * directory is atomic.
 */
export function writeStateFile(path: string, text: string, mode = 0o600): void {
	mkdirSync(stateDir(), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, text, { mode });
	renameSync(tmp, path);
}

/**
 * Read a state file, falling back ONCE to the omp-era install's copy.
 *
 * The old install keeps running (that is the coexistence contract), so the
 * legacy path is opened read-only and never moved or deleted. The first write
 * through `writeStateFile` lands in the new location and the old file stops
 * being consulted, because this only looks there when the new file is absent.
 *
 * Hosts are deliberately NOT migrated: the old list names forward ports that
 * the old server owns and remote ports where an omp-era piw is listening.
 */
export function readStateFile(path: string, legacy?: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		// Absent or unreadable: fall through to the legacy copy, if any.
	}
	if (!legacy) return undefined;
	try {
		return readFileSync(legacy, "utf8");
	} catch {
		return undefined;
	}
}

/** The omp-era install's state directory. Read-only, for the fallback above. */
export function legacyPath(name: string): string {
	return join(homedir(), ".omp", "agent", name);
}
