/**
 * commands.ts — slash-command completion for the composer.
 *
 * The matching lives here, apart from the panel that renders it, because it is
 * the part with rules: what counts as "completing a command", which commands a
 * query matches, and what pressing Enter on a row puts in the box. The panel
 * itself is a list with a highlight.
 *
 * The catalog comes from the session (`Snapshot.commands`), never from a table
 * in here: which commands exist depends on the project's extensions, skills
 * and prompt templates under `.pi/`, and a hardcoded list would confidently
 * offer a command the agent does not have.
 */

import type { PiCommand } from "../shared/types.js";

/** What the composer is currently completing: the command word itself. */
export interface Completion {
	/** The text after the slash: "" for a bare `/`, "co" for `/co`. */
	query: string;
}

/**
 * One row of the picker. `insert` replaces the whole composer text; `label`
 * is the row as it reads, which is why it carries its own leading slash.
 */
export interface CommandOption {
	insert: string;
	label: string;
	description?: string;
	/** `extension`, `prompt` or `skill`, shown as a dim tag on the right. */
	source?: string;
}

/**
 * Read the composer text as a completion in progress, or nothing.
 *
 * Deliberately strict: the picker opens only while the WHOLE composer is one
 * unfinished command word. A slash mid-sentence is prose ("and/or"), a slash
 * on the second line belongs to whatever the first line is saying, and text
 * after the name is the argument the user is writing, not a name the picker
 * can help with.
 */
export function parseCompletion(text: string): Completion | null {
	if (text.includes("\n")) return null;
	const m = /^\/(\S*)$/.exec(text);
	return m ? { query: m[1] ?? "" } : null;
}

/** Case-insensitive, prefix-first ranking. `-1` means "no match". */
function rank(candidate: string, query: string): number {
	if (!query) return 0;
	const at = candidate.toLowerCase().indexOf(query.toLowerCase());
	if (at < 0) return -1;
	return at === 0 ? 0 : 1;
}

/**
 * The rows to show for a completion, best match first.
 *
 * Every row inserts a TRAILING SPACE, because every pi command that takes
 * arguments takes them as free text after the name: `/skill:review the auth
 * change`. One keypress leaves the caret where the argument goes.
 */
export function completionOptions(commands: PiCommand[], completion: Completion): CommandOption[] {
	return commands
		.map((c) => ({ c, r: rank(c.name, completion.query) }))
		.filter(({ r }) => r >= 0)
		.sort((a, b) => a.r - b.r || a.c.name.localeCompare(b.c.name))
		.map(({ c }) => ({
			insert: `/${c.name} `,
			label: `/${c.name}`,
			...(c.description ? { description: c.description } : {}),
			...(c.source ? { source: c.source } : {}),
		}));
}
