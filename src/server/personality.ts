/**
 * personality.ts — extra system-prompt text, owned by this server.
 *
 * A previous install resolved `<agent dir>/PERSONALITY.md` itself and
 * substituted it for a preset. pi has no such file and no such setting: the
 * only way to add text to the system prompt is `--append-system-prompt`,
 * which takes a path and is read at spawn.
 *
 * So the file is ours. It lives in the state directory with everything else
 * this server persists, and agent.ts passes it on every spawn when it is
 * non-empty. The consequence the settings dialog states: an edit applies to
 * sessions started AFTER the save, because a running child has already built
 * its system prompt.
 *
 * Clearing the box and saving writes an empty file, which is how the override
 * is turned off — nothing here deletes anything.
 */

import { readFileSync } from "node:fs";
import { statePath, writeStateFile } from "./state.js";

/**
 * A personality block is prose, and prose that needs 256 KB is not a
 * personality. The cap exists so a paste accident cannot put megabytes into
 * every future system prompt.
 */
const MAX_BYTES = 256 * 1024;

/** The file agent.ts passes to `--append-system-prompt`. */
export function personalityPath(): string {
	return statePath("personality.md");
}

export interface Personality {
	/** Absolute path, shown in the UI so the field names the file it edits. */
	path: string;
	content: string;
	/** False when no file has been written yet, so nothing is appended. */
	exists: boolean;
}

export function readPersonality(): Personality {
	const path = personalityPath();
	try {
		return { path, content: readFileSync(path, "utf8"), exists: true };
	} catch {
		// Absent is the normal state of a machine that never set one, so it is
		// reported rather than thrown: the field opens empty and saving creates
		// the file.
		return { path, content: "", exists: false };
	}
}

/** Replace the file with `content`, verbatim apart from a trailing newline. */
export function writePersonality(content: string): Personality {
	if (typeof content !== "string") throw new Error("content must be a string");
	const text = content.length && !content.endsWith("\n") ? `${content}\n` : content;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_BYTES) {
		throw new Error(`too large: ${bytes} bytes (max ${MAX_BYTES})`);
	}

	const path = personalityPath();
	writeStateFile(path, text);
	return { path, content: text, exists: true };
}
