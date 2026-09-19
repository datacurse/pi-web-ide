/**
 * commands.ts — slash-command completion for the composer.
 *
 * The matching lives here, apart from the panel that renders it, because it is
 * the part with rules: what counts as "completing a command", which commands a
 * query matches, and what pressing Enter on a row puts in the box. The panel
 * itself is a list with a highlight.
 *
 * The catalog comes from the session (`Snapshot.commands`), never from a table
 * in here: which commands exist depends on the project's extensions, plugins
 * and `.omp/commands` files, and a hardcoded list would confidently offer a
 * command the agent does not have.
 */

import type { PiCommand } from "../shared/types.js";

/** What the composer is currently completing. */
export type Completion =
	/** The command word itself: `/`, `/co`. */
	| { kind: "command"; query: string }
	/** A subcommand of a named command: `/fast `, `/compact so`. */
	| { kind: "sub"; name: string; query: string };

/**
 * One row of the picker. `insert` replaces the whole composer text; `label`
 * is the row as it reads, which is why it carries its own leading slash: a
 * command IS `/compact`, a subcommand is `soft`, and printing `/soft` would
 * claim a command that does not exist.
 */
export interface CommandOption {
	insert: string;
	label: string;
	description?: string;
	/** Argument shape, e.g. `[on|off|status]`. Only on command rows. */
	hint?: string;
}

/**
 * Read the composer text as a completion in progress, or nothing.
 *
 * Deliberately strict: the picker opens only while the WHOLE composer is one
 * unfinished command. A slash mid-sentence is prose ("and/or"), a slash on the
 * second line belongs to whatever the first line is saying, and text past the
 * subcommand word — `/compact soft focus on X` — is arguments the user is
 * writing, not a name the picker can help with.
 *
 * The trailing-space cases are what make picking feel right: `/fast ` matches
 * with an empty subcommand query, so accepting a command with subcommands
 * immediately offers them, while `/fast on ` matches nothing and the panel
 * closes.
 */
export function parseCompletion(text: string): Completion | null {
	if (text.includes("\n")) return null;
	const m = /^\/(\S*)(?:\s+(\S*))?$/.exec(text);
	if (!m) return null;
	const name = m[1] ?? "";
	const sub = m[2];
	if (sub === undefined) return { kind: "command", query: name };
	return { kind: "sub", name, query: sub };
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
 * Aliases match but are never rows of their own: `/models` finds `model`, and
 * the row still inserts the canonical name, because that is the name the rest
 * of the catalog (and the subcommand list) is keyed by.
 *
 * Every command row inserts a TRAILING SPACE. That is what lets one keypress
 * chain: `/fa` + Enter gives `/fast `, which is the state that lists `on`,
 * `off`, `status`.
 */
export function completionOptions(commands: PiCommand[], completion: Completion): CommandOption[] {
	if (completion.kind === "sub") {
		const parent = commands.find(
			(c) => c.name === completion.name || c.aliases?.includes(completion.name),
		);
		if (!parent?.subcommands) return [];
		return parent.subcommands
			.map((s) => ({ s, r: rank(s.name, completion.query) }))
			.filter(({ r }) => r >= 0)
			.sort((a, b) => a.r - b.r)
			.map(({ s }) => ({
				insert: `/${parent.name} ${s.name} `,
				label: s.name,
				...(s.description ? { description: s.description } : {}),
			}));
	}

	return commands
		.map((c) => {
			const ranks = [c.name, ...(c.aliases ?? [])].map((n) => rank(n, completion.query));
			const best = ranks.filter((r) => r >= 0).sort((a, b) => a - b)[0];
			return { c, r: best === undefined ? -1 : best };
		})
		.filter(({ r }) => r >= 0)
		.sort((a, b) => a.r - b.r)
		.map(({ c }) => ({
			insert: `/${c.name} `,
			label: `/${c.name}`,
			...(c.description ? { description: c.description } : {}),
			...(c.hint ? { hint: c.hint } : {}),
		}));
}
