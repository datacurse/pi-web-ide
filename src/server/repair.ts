/**
 * repair.ts — make a poisoned session file openable again.
 *
 * Everything else in this server reads pi's store and never writes it. This
 * file is the one exception, and it earns it: the damage it repairs is
 * permanent, self-replicating, and invisible until the next prompt fails.
 *
 * ## The damage
 *
 * pi builds every user turn as `[{type:"text", text}, ...images]` — the text
 * block is unconditional (`core/agent-session.js`, "Add user message"). An
 * image-only prompt therefore persists a block with `text: ""`.
 *
 * pi's OWN anthropic provider filters blank blocks on the way to the wire
 * (`pi-ai/dist/api/anthropic-messages.js`: `blocks.filter(b => b.text.trim()
 * .length > 0)`). A provider PACKAGE is under no obligation to, and
 * `pi-sub-anthropic` does not — it maps user blocks straight through. The API
 * answers:
 *
 *     400 invalid_request_error: messages: text content blocks must be non-empty
 *
 * The block is written to the JSONL BEFORE the request goes out, so it is
 * still there on the next turn, and the one after that. Every subsequent
 * prompt in that session replays it and fails identically. The session is
 * bricked, not the turn — the same failure mode as a dangling tool call, with
 * the same remedy.
 *
 * ## Why a file rewrite and not a filter
 *
 * `healDanglingToolCalls` fixes what the BROWSER renders. It cannot fix what
 * the PROVIDER receives: pi loads history from its own file and never asks
 * this server what it thinks the transcript is. The only seam that reaches
 * the request is the file itself, and the only safe moment to write it is
 * before the child that will hold it is spawned.
 *
 * Rewritten via temp + rename, so an interrupted repair leaves the original
 * intact rather than half a session.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * What an image-only turn is rewritten to say.
 *
 * Deliberately the same words `pi-sub-anthropic` uses when it synthesizes a
 * caption for an image-only tool result, so a transcript that mixes repaired
 * and live turns reads consistently.
 */
const IMAGE_CAPTION = "(see attached image)";

export interface RepairResult {
	/** User turns whose empty text block was captioned. */
	captioned: number;
	/** Messages dropped entirely: no text, no images, nothing to say. */
	dropped: number;
}

/** Nothing to do. Returned by the fast path so callers can skip logging. */
const CLEAN: RepairResult = { captioned: 0, dropped: 0 };

/**
 * Remove empty text blocks from a session file's user turns.
 *
 * Returns what it changed. A file it cannot read, cannot parse or does not
 * need to touch is left exactly as it is and reported as clean — a repair
 * that is not clearly necessary is not worth the risk of writing to another
 * program's store.
 */
export function repairSessionFile(file: string): RepairResult {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		// Unreadable is the open path's problem to report, not ours to guess at.
		return CLEAN;
	}

	// A file with no empty text block cannot need this pass, and this check is
	// a substring scan rather than a JSON parse of several megabytes. The
	// common case is every session ever opened, so it is worth the line.
	if (!text.includes('"text":""')) return CLEAN;

	const lines = text.split("\n");
	const out: string[] = [];
	let captioned = 0;
	let dropped = 0;

	for (const line of lines) {
		if (!line) {
			// Preserve the trailing newline's empty tail, and any torn final
			// line, byte for byte. This pass rewrites turns, not formatting.
			out.push(line);
			continue;
		}

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// pi appends live and the last line of an active session is
			// regularly half-written. Copy it through untouched.
			out.push(line);
			continue;
		}

		const fixed = repairEntry(entry);
		if (fixed === "unchanged") {
			out.push(line);
			continue;
		}
		if (fixed === "drop") {
			dropped++;
			continue;
		}
		captioned++;
		out.push(JSON.stringify(entry));
	}

	if (captioned === 0 && dropped === 0) return CLEAN;

	/*
	 * Temp file in the SAME directory, because rename(2) is only atomic within
	 * a filesystem and /tmp is routinely a different one. Removed on a failed
	 * write so a full disk does not leave litter in pi's store.
	 */
	const tmp = join(dirname(file), `.${Date.now()}.piw-repair.tmp`);
	try {
		writeFileSync(tmp, out.join("\n"));
		renameSync(tmp, file);
	} catch {
		try {
			unlinkSync(tmp);
		} catch {
			// Never existed, or already gone. Either way there is nothing to clean.
		}
		return CLEAN;
	}

	return { captioned, dropped };
}

/**
 * Repair one entry IN PLACE. "unchanged" leaves the original line untouched,
 * "drop" removes it, "fixed" means re-serialize.
 *
 * Only `user` messages are touched. An assistant turn with an empty text
 * block is skipped by every provider path we know of (pi's own and the
 * package's both `continue` on blank assistant text), and rewriting a
 * signed thinking block would invalidate a signature Anthropic verifies.
 */
function repairEntry(entry: Record<string, unknown>): "unchanged" | "fixed" | "drop" {
	if (entry.type !== "message") return "unchanged";
	const message = entry.message;
	if (!message || typeof message !== "object") return "unchanged";

	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "user" || !Array.isArray(m.content)) return "unchanged";

	const blocks = m.content as Array<Record<string, unknown>>;
	const isText = (b: unknown): b is { type: "text"; text: string } =>
		!!b && typeof b === "object" && (b as { type?: unknown }).type === "text";

	const empty = blocks.filter((b) => isText(b) && !String(b.text ?? "").trim());
	if (empty.length === 0) return "unchanged";

	const kept = blocks.filter((b) => !empty.includes(b));
	if (kept.length === 0) {
		// Neither words nor images: the turn conveyed nothing when it was sent
		// and conveys nothing on replay. Dropping it is the only repair that
		// leaves a valid request, since a user turn cannot be empty either.
		return "drop";
	}

	/*
	 * Images survived, so the turn DID mean something — "look at this" — and
	 * the caption says so. Prepended rather than appended: the text block
	 * comes first in every turn pi builds, and a caption after the image it
	 * captions reads as a reply to it.
	 */
	const hasImage = kept.some((b) => (b as { type?: unknown }).type === "image");
	m.content = hasImage ? [{ type: "text", text: IMAGE_CAPTION }, ...kept] : kept;
	return "fixed";
}
