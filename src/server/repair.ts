/**
 * repair.ts — make a poisoned session file openable again.
 *
 * Everything else in this server reads pi's store and never writes it. This
 * file is the one exception, and it earns it: the damage it repairs is
 * permanent, self-replicating, and invisible until the next prompt fails.
 *
 * ## The damage, part one: empty text blocks
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
 * ## The damage, part two: unanswered tool calls
 *
 * The assistant message is persisted at message_end and each tool result is
 * persisted after it, so anything that kills the run in between — a crash, or
 * a bash tool that restarts its own host process — leaves a `tool_use` with no
 * `tool_result`. The API answers:
 *
 *     400 invalid_request_error: messages.N: `tool_use` ids were found without
 *     `tool_result` blocks immediately after: toolu_...
 *
 * Same shape as the empty block: written before the request, replayed by every
 * later prompt, session bricked rather than turn. Same remedy.
 *
 * ## Why a file rewrite and not a filter
 *
 * `healDanglingToolCalls` in agent.ts fixes what the BROWSER renders. It cannot
 * fix what the PROVIDER receives: pi loads history from its own file and never
 * asks this server what it thinks the transcript is. The only seam that reaches
 * the request is the file itself, and the only safe moment to write it is
 * before the child that will hold it is spawned.
 *
 * Rewritten via temp + rename, so an interrupted repair leaves the original
 * intact rather than half a session.
 */

import { randomBytes } from "node:crypto";
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

/**
 * What an abandoned tool call is answered with. Same words agent.ts uses for
 * the render-time heal, so a transcript reads the same whichever pass got there
 * first.
 */
const INTERRUPTED = "Interrupted: the session ended before this tool returned.";

export interface RepairResult {
	/** User turns whose empty text block was captioned. */
	captioned: number;
	/** Messages dropped entirely: no text, no images, nothing to say. */
	dropped: number;
	/** Tool calls given a synthetic "interrupted" result. */
	answered: number;
}

/** Nothing to do. Returned by the fast path so callers can skip logging. */
const CLEAN: RepairResult = { captioned: 0, dropped: 0, answered: 0 };

/** Entry ids in this format are 8 hex chars. */
const newId = () => randomBytes(4).toString("hex");

/**
 * Tool call ids in this file that never got a result, mapped to their tool name
 * so the synthetic result can name it.
 *
 * Collected across the WHOLE file before anything is rewritten, because a
 * result does not have to sit on the line after its call.
 *
 * ponytail: parses every line, so a repaired file is parsed twice. ~60ms on a
 * 2.5MB session, once at open. Fuse the passes if that ever shows up.
 */
function unansweredCalls(lines: string[]): Map<string, string> {
	const calls = new Map<string, string>();
	const answered = new Set<string>();

	for (const line of lines) {
		if (!line) continue;
		let entry: { type?: unknown; message?: unknown };
		try {
			entry = JSON.parse(line) as { type?: unknown; message?: unknown };
		} catch {
			continue;
		}
		if (entry.type !== "message") continue;
		const m = entry.message as { role?: unknown; content?: unknown; toolCallId?: unknown } | undefined;
		if (!m || typeof m !== "object") continue;

		if (m.role === "toolResult" && typeof m.toolCallId === "string") answered.add(m.toolCallId);
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const b of m.content as Array<Record<string, unknown>>) {
			if (b?.type === "toolCall" && typeof b.id === "string") {
				calls.set(b.id, typeof b.name === "string" ? b.name : "unknown");
			}
		}
	}

	for (const id of answered) calls.delete(id);
	return calls;
}

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

	/*
	 * A file with no blank text block cannot need this pass, and this check is
	 * a scan rather than a JSON parse of several megabytes. The common case is
	 * every session ever opened, so it is worth the line.
	 *
	 * It must agree with `repairEntry`, which tests `.trim()`: a plain
	 * `includes('"text":""')` misses `" "` and `"\n"`, and a file that needs
	 * the repair would return clean here and stay bricked. Hence the escapes —
	 * whitespace inside a JSON string arrives as `\n`, two characters.
	 */
	const lines = text.split("\n");
	const needsCaption = /"text":"(?:\s|\\[nrtf])*"/.test(text);
	const pending = text.includes('"toolCall"') ? unansweredCalls(lines) : new Map<string, string>();
	if (!needsCaption && pending.size === 0) return CLEAN;

	const out: string[] = [];
	let captioned = 0;
	let dropped = 0;
	let answered = 0;

	/*
	 * Entries are a tree linked by id/parentId, so an entry that is removed or
	 * displaced has to hand its id on: `remap` says "anything that claimed this
	 * parent now belongs to that one". Without it a drop orphans the rest of the
	 * session (pi renders orphans as new roots) and an insert leaves the
	 * synthetic result off the chain the provider is rebuilt from.
	 */
	const remap = new Map<string, string>();

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

		const parent = entry.parentId;
		const rechained = typeof parent === "string" && remap.has(parent);
		if (rechained) entry.parentId = remap.get(parent as string);

		const fixed = repairEntry(entry);
		if (fixed === "drop") {
			dropped++;
			// Adopt this entry's children onto its own parent, or they vanish.
			if (typeof entry.id === "string") remap.set(entry.id, (entry.parentId ?? null) as string);
			continue;
		}
		if (fixed === "fixed") captioned++;
		out.push(fixed === "unchanged" && !rechained ? line : JSON.stringify(entry));

		answered += appendMissingResults(entry, pending, out, remap);
	}

	if (captioned === 0 && dropped === 0 && answered === 0) return CLEAN;

	/*
	 * Temp file in the SAME directory, because rename(2) is only atomic within
	 * a filesystem and /tmp is routinely a different one. Removed on a failed
	 * write so a full disk does not leave litter in pi's store.
	 */
	const tmp = join(dirname(file), `.${Date.now()}.pwi-repair.tmp`);
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

	return { captioned, dropped, answered };
}

/**
 * Emit a synthetic `toolResult` entry for every call in `entry` that this file
 * never answered, chained after it, and point `entry`'s children at the last
 * one. Returns how many were written.
 *
 * Immediately after the call, because the provider's rule is not "somewhere
 * later" — the result must be in the NEXT message.
 */
function appendMissingResults(
	entry: Record<string, unknown>,
	pending: Map<string, string>,
	out: string[],
	remap: Map<string, string>,
): number {
	if (pending.size === 0 || entry.type !== "message") return 0;
	const m = entry.message as { role?: unknown; content?: unknown } | undefined;
	if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return 0;

	let parentId = typeof entry.id === "string" ? entry.id : null;
	const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date().toISOString();
	let written = 0;

	for (const b of m.content as Array<Record<string, unknown>>) {
		if (b?.type !== "toolCall" || typeof b.id !== "string") continue;
		const toolName = pending.get(b.id);
		if (toolName === undefined) continue;
		// Drop it from `pending` so a session that somehow repeats a call id
		// cannot get two results for it, which is the same 400 in reverse.
		pending.delete(b.id);

		const id = newId();
		out.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: b.id,
					toolName,
					content: [{ type: "text", text: INTERRUPTED }],
					isError: true,
					timestamp: Date.parse(timestamp) || Date.now(),
				},
			}),
		);
		parentId = id;
		written++;
	}

	if (written > 0 && typeof entry.id === "string" && parentId) remap.set(entry.id, parentId);
	return written;
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
