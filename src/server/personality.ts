/**
 * personality.ts — read and write omp's own `PERSONALITY.md`.
 *
 * This is the one agent-facing file piw edits, and it is edited IN PLACE:
 * omp resolves `<agent dir>/PERSONALITY.md` and substitutes it for the text of
 * the personality preset selected by the `personality` setting. There is no
 * project-level or other-config-base lookup, and an empty or unreadable file
 * falls back to the configured preset — which is what makes "clear the box and
 * save" a legitimate way to turn the override off, and why nothing here
 * deletes the file.
 *
 * The settings dialog is otherwise browser-only (see prefs.ts), and piw's
 * non-goals say the things that change how the agent RUNS belong in omp's
 * config rather than in a second place to look. This does not break that rule
 * so much as take it literally: the field writes omp's file, byte for byte,
 * and reads it back on every open. There is no piw-side copy to drift.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A personality block is prose, and prose that needs 256 KB is not a
 * personality. The cap exists so a paste accident cannot put megabytes into
 * every future system prompt.
 */
const MAX_BYTES = 256 * 1024;

/**
 * Resolved per call, not captured at import: the test points PIW_AGENT_DIR at
 * a temp dir, and a module-level constant would bake in whatever the env held
 * when this module first loaded. Same shape as PIW_SESSION_ROOT in
 * sessions.ts.
 *
 * omp's own resolution is profile- and XDG-aware; this is the default it uses
 * and the same path projects.ts and hosts.ts already write next to.
 */
function file(): string {
	const dir = process.env.PIW_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	return join(dir, "PERSONALITY.md");
}

export interface Personality {
	/** Absolute path, shown in the UI so the field names the file it edits. */
	path: string;
	content: string;
	/** False when omp is using the configured preset because there is no file. */
	exists: boolean;
}

export function readPersonality(): Personality {
	const path = file();
	try {
		return { path, content: readFileSync(path, "utf8"), exists: true };
	} catch {
		// Absent is the normal state of a machine that never overrode the
		// preset, so it is reported rather than thrown: the field opens empty
		// and saving creates the file.
		return { path, content: "", exists: false };
	}
}

/**
 * Replace the file with `content`, verbatim apart from a trailing newline.
 *
 * Written to a sibling temp file and renamed, because the alternative is a
 * truncated PERSONALITY.md: `writeFileSync` truncates first, so a crash or a
 * full disk mid-write would leave omp reading half a personality on every
 * subsequent session. rename(2) within one directory is atomic.
 */
export function writePersonality(content: string): Personality {
	if (typeof content !== "string") throw new Error("content must be a string");
	const text = content.length && !content.endsWith("\n") ? `${content}\n` : content;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_BYTES) {
		throw new Error(`too large: ${bytes} bytes (max ${MAX_BYTES})`);
	}

	const path = file();
	mkdirSync(join(path, ".."), { recursive: true });
	const tmp = `${path}.piw-tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, path);
	return { path, content: text, exists: true };
}
