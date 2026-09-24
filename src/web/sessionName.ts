/**
 * What a session is CALLED, in one place.
 *
 * The session list and the tab strip have to agree — the same conversation
 * reading two different ways in two panels of one window is a bug you cannot
 * unsee — and there are three sources to reconcile: the name pi holds (set by
 * hand through the rename control, or written for you by the server's
 * one-shot naming child), the first user message, and, for a session with
 * neither, a placeholder.
 */

/** Precedence is fixed: an explicit name beats anything derived from content. */
export function sessionLabel(
	info: { name?: string; firstMessage?: string } | undefined,
	short: boolean,
): string {
	const name = info?.name?.trim();
	if (name) return name;
	// One line: this is raw prompt text, and a leading newline would render as
	// an empty row.
	const first = info?.firstMessage?.replace(/\s+/g, " ").trim();
	if (first) return short ? shortName(first) : first.slice(0, 60);
	return NEW_SESSION;
}

/**
 * A session with no name and nothing said in it yet.
 *
 * It used to be eight characters of the file's uuid, which is unique but says
 * nothing — a fresh tab read `01a0ceba`, and the one thing the user knows
 * about that tab is that they just made it. Two unnamed sessions therefore
 * read alike; they are told apart by position until the first message names
 * them, which is a second or two later.
 */
const NEW_SESSION = "New session";

/** How many words a generated name may run to before it stops being a name. */
const SHORT_WORDS = 8;
/** And the hard ceiling, for eight words of `--enable-something-long`. */
const SHORT_CHARS = 48;

/**
 * A short name from the first prompt: its opening clause, capitalised.
 *
 * The first sentence rather than the first N characters, because a prompt
 * almost always opens by saying what it is about and then qualifies it for
 * three more lines — "not a fan of opening directory like this. i would
 * rather…" is a whole conversation whose subject is the first eight words.
 * Both limits are needed: eight words of ordinary prose fit a row, eight
 * words of pasted flags do not.
 *
 * Deliberately not a model call. This is the instant, free option in the row
 * menu, and it is also what the short-names preference renders for a session
 * nobody has named — it must not cost a token, a round trip, or change under
 * you on a re-render. Asking a model for a better name is the OTHER menu
 * item, which hands the job to the server's one-shot naming child.
 */
export function shortName(firstMessage: string): string {
	const line = firstMessage.replace(/\s+/g, " ").trim();
	if (!line) return "";
	// Up to the first sentence end. `[^.!?]+` and not a split, so a prompt with
	// no punctuation at all is simply the whole line.
	let sentence = /^[^.!?]+/.exec(line)?.[0] ?? line;
	/*
	 * A comma ends the clause too, but ONLY when what follows it is another
	 * instruction: "fix the parser, and then run the tests" is about fixing
	 * the parser. A word-count rule was the first attempt and it cut in the
	 * wrong place twice over — "hey, can you fix the parser" became "Hey", and
	 * "tell me please, do i have code for X" became "Tell me please", which
	 * names the politeness and drops the subject.
	 */
	const clause = /^(.+?),\s+(?:and|then|but|so|or|also|plus)\b/i.exec(sentence);
	if (clause) sentence = clause[1];

	let out = "";
	for (const word of sentence.trim().split(" ").slice(0, SHORT_WORDS)) {
		const next = out ? `${out} ${word}` : word;
		// A single word past the ceiling is still that word, truncated: the
		// alternative is an empty name.
		if (next.length > SHORT_CHARS) {
			if (out) break;
			out = word.slice(0, SHORT_CHARS);
			break;
		}
		out = next;
	}

	// Trailing punctuation is a leftover of where the clause was cut, never
	// part of the name: "fix the parser," reads as unfinished.
	out = out.replace(/[\s,;:–—-]+$/, "");
	return out ? out[0].toUpperCase() + out.slice(1) : line.slice(0, SHORT_CHARS);
}

