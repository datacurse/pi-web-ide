/**
 * hunks.ts — the agent-edit review format.
 *
 * This is the seam. The editor component is swappable; this is not, so it is
 * plain data with ZERO imports, same rule as types.ts: a hunk must survive the
 * wire, localStorage and a test fixture without dragging CodeMirror or node
 * into any of them.
 *
 * TWO THINGS DECIDE THIS WHOLE DESIGN:
 *
 * 1. Hunks are DERIVED FROM pi's own edit tool args, never re-diffed from file
 *    contents. pi's `edit` takes `{ path, edits: [{ oldText, newText }] }` and
 *    `write` takes `{ path, content }` — the agent has already said exactly
 *    what it meant to change. Re-diffing a before/after would split one
 *    intended edit in two, or merge two unrelated ones, and show the user a
 *    change the agent never expressed.
 *
 * 2. The edit is ALREADY ON DISK. pi's edit tool writes during execution and
 *    pwi installs no `tool_call` gate, so by the time the browser hears about
 *    a hunk the file has changed. This is a review-after-the-fact pane, not an
 *    approval queue: `accepted` is a no-op that records a decision, and
 *    `rejected` is what performs a write — putting `oldText` back. Anyone
 *    reading this as "apply on accept" will build a pane that double-applies
 *    every edit.
 */

/**
 * Where a hunk sits in its file, as TEXT rather than offsets.
 *
 * Character offsets are wrong by construction: a hunk is reviewed
 * asynchronously, and any reverted hunk — or any keystroke — above it shifts
 * every offset below. `newText` plus surrounding lines lets a moved hunk be
 * relocated by search instead of written at a position that has since moved.
 *
 * `line` is a HINT, for scrolling and for choosing between identical matches.
 * Trusting it as an address is the offset bug with extra steps.
 */
export interface HunkAnchor {
	/** 0-based line where the change started when the agent made it. A hint. */
	line: number;
	/** Up to 3 lines immediately before the changed text, for relocation. */
	before: string;
	/** Up to 3 lines immediately after it. */
	after: string;
}

/**
 * `pending` until the user decides. Owned OUTSIDE the editor — the editor
 * renders state, never holds it — so a decision survives a remount, a file
 * switch, a collapsed tool card and a reload.
 *
 * `accepted` changes no bytes: the agent's text is already what is on disk.
 * It means "reviewed, keeping it", which is why it is worth persisting at all.
 */
export type HunkState = "pending" | "accepted" | "rejected";

/** One reviewable change: exactly one `oldText`→`newText` pair the agent made. */
export interface Hunk {
	/**
	 * Stable for the life of the change. `<toolCallId>:<index>` — pi's own tool
	 * call id plus the position in its `edits` array, so the id is derivable
	 * from the event and identical when the same event is replayed from the
	 * session file after a reload. A random id would leave a reloaded
	 * transcript unable to find the decision it stored.
	 */
	id: string;
	/** Absolute, as pi's tool args carry it. */
	path: string;
	/**
	 * Hash of the file as it was BEFORE the agent wrote, or null when the agent
	 * created the file. This is what makes a revert SAFE to refuse: if the file
	 * no longer contains what this hunk expects, something else has edited it
	 * since and putting `oldText` back would clobber that. Null for a creation
	 * because "did not exist" and "existed empty" revert differently.
	 */
	baseHash: string | null;
	/** What was there before. Empty for an insertion or a new file. */
	oldText: string;
	/** What the agent put there. Empty for a deletion. */
	newText: string;
	anchor: HunkAnchor;
	state: HunkState;
}

/** How a hunk relates to the file as it is RIGHT NOW. */
export type HunkFit =
	/** `newText` occurs exactly once: safe to revert. */
	| { fit: "unique"; from: number; to: number }
	/**
	 * `newText` occurs more than once. The anchor's line hint picks the nearest,
	 * but the ambiguity is REPORTED rather than silently resolved — "reverted
	 * the wrong one of three identical blocks" is not a failure a user can see.
	 */
	| { fit: "ambiguous"; from: number; to: number; count: number }
	/** Gone — already reverted, or overwritten. Nothing to do; never guess. */
	| { fit: "missing" };

/**
 * FNV-1a, 32-bit, hex. Deliberately not a crypto hash: this answers "did this
 * file move under me", an accident detector rather than a security boundary —
 * and `node:crypto` is absent from the browser bundle while `SubtleCrypto` is
 * async and would make every hunk construction a promise.
 *
 * ponytail: 32-bit FNV. Collision odds are irrelevant for "same file, seconds
 * apart"; move to SHA-256 if hashes are ever compared across machines.
 */
export function hashContent(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		// Math.imul, because `h * 16777619` exceeds 2^53 and silently loses bits.
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

const CONTEXT_LINES = 3;

function anchorAt(content: string, at: number, text: string): HunkAnchor {
	const lines = content.split("\n");
	const line = content.slice(0, at).split("\n").length - 1;
	const endLine = line + text.split("\n").length - 1;
	return {
		line,
		before: lines.slice(Math.max(0, line - CONTEXT_LINES), line).join("\n"),
		after: lines.slice(endLine + 1, endLine + 1 + CONTEXT_LINES).join("\n"),
	};
}

/**
 * Build the hunks for one pi `edit` tool call.
 *
 * `before` is the file as it was when the agent read it. Every `oldText` is
 * located in it to fill the anchor — an edit whose `oldText` is not in the
 * content it claims to have edited is DROPPED rather than anchored at line 0,
 * because a hunk that cannot be placed is a hunk that must never be reverted.
 */
export function hunksFromEdit(
	toolCallId: string,
	path: string,
	before: string,
	edits: Array<{ oldText: string; newText: string }>,
): Hunk[] {
	const baseHash = hashContent(before);
	const out: Hunk[] = [];
	for (const [i, edit] of edits.entries()) {
		const at = before.indexOf(edit.oldText);
		if (at === -1) continue;
		out.push({
			id: `${toolCallId}:${i}`,
			path,
			baseHash,
			oldText: edit.oldText,
			newText: edit.newText,
			anchor: anchorAt(before, at, edit.oldText),
			state: "pending",
		});
	}
	return out;
}

/**
 * The single hunk for a pi `write` call: whole-file replacement.
 *
 * `before` is null for a file the agent created, which is what distinguishes
 * "did not exist" from "existed empty" — reverting the first means deleting,
 * reverting the second means truncating, and the pane must not confuse them.
 */
export function hunkFromWrite(
	toolCallId: string,
	path: string,
	before: string | null,
	content: string,
): Hunk {
	return {
		id: `${toolCallId}:0`,
		path,
		baseHash: before === null ? null : hashContent(before),
		oldText: before ?? "",
		newText: content,
		anchor: { line: 0, before: "", after: "" },
		state: "pending",
	};
}

/**
 * Locate a hunk's CURRENT text in the file as it is now.
 *
 * Searches for `newText`, not `oldText`: the agent's text is what is on disk,
 * and finding it is what makes a revert possible. Search-based rather than
 * offset-based so it survives the user editing above a pending hunk.
 */
export function fitHunk(hunk: Hunk, current: string): HunkFit {
	/*
	 * A pure deletion left NO text behind, so there is nothing to search for
	 * and nothing to replace: its anchor's `before` is the only thing locating
	 * it, and the fit is an INSERTION POINT — a zero-width span — not a span
	 * covering the anchor. Returning the anchor's own span here would make a
	 * revert overwrite the three context lines with `oldText` and destroy them.
	 */
	const insertion = hunk.newText === "";
	const needle = insertion ? hunk.anchor.before : hunk.newText;
	// Nothing to anchor to: the change was at the very start of the file.
	if (needle === "") return { fit: "unique", from: 0, to: insertion ? 0 : current.length };

	const found: number[] = [];
	for (let at = current.indexOf(needle); at !== -1; at = current.indexOf(needle, at + 1)) {
		found.push(at);
	}
	if (found.length === 0) return { fit: "missing" };

	const span = (at: number) => {
		const end = at + needle.length;
		if (!insertion) return { from: at, to: end };
		// `before` is a join of whole lines, so the deleted text began after the
		// newline that follows it. Landing on the newline itself would reinsert
		// the line before its own break.
		const point = current[end] === "\n" ? end + 1 : end;
		return { from: point, to: point };
	};
	if (found.length === 1) return { fit: "unique", ...span(found[0]) };

	// Nearest to the remembered line wins. Compared as lines, not offsets:
	// offsets are exactly what has moved.
	const lineOf = (at: number) => current.slice(0, at).split("\n").length - 1;
	const best = found.reduce((a, b) =>
		Math.abs(lineOf(a) - hunk.anchor.line) <= Math.abs(lineOf(b) - hunk.anchor.line) ? a : b,
	);
	return { fit: "ambiguous", ...span(best), count: found.length };
}

/**
 * The file as it read BEFORE the agent touched it, reconstructed by undoing
 * every hunk in `hunks` — the "original" side of the merge view.
 *
 * Reverted back-to-front so each splice cannot invalidate the offsets of the
 * ones not yet done, and a hunk that no longer fits is SKIPPED rather than
 * forced: forcing a stale revert corrupts the file, which is the one outcome
 * worse than a change left standing.
 */
export function revertHunks(current: string, hunks: Hunk[]): string {
	const spans: Array<{ from: number; to: number; text: string }> = [];
	for (const h of hunks) {
		const fit = fitHunk(h, current);
		if (fit.fit === "missing") continue;
		spans.push({ from: fit.from, to: fit.to, text: h.oldText });
	}
	spans.sort((a, b) => b.from - a.from);
	let out = current;
	for (const s of spans) out = out.slice(0, s.from) + s.text + out.slice(s.to);
	return out;
}

/**
 * What the file should contain once the user's decisions are honoured: every
 * `rejected` hunk undone, everything else left exactly as the agent wrote it.
 *
 * This is the ONLY function that produces bytes to write back, and it takes
 * the current file rather than a remembered one so a hand edit between the
 * agent's write and the user's click is preserved instead of overwritten.
 */
export function resolve(current: string, hunks: Hunk[]): string {
	return revertHunks(
		current,
		hunks.filter((h) => h.state === "rejected"),
	);
}
