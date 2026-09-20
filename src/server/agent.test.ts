// Run: node --import tsx src/server/agent.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
	FrameReader,
	healDanglingToolCalls,
	isConversation,
	spawnArgs,
	toAsk,
	toCommands,
	toEvents,
	toPiMessage,
} from "./agent.js";
import type { PiEvent } from "../shared/types.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Spawn arguments
//
// Which flags reach pi is the most consequential line in agent.ts, and the
// ones that must NOT be there are the reason this is pinned: `--cwd` does not
// exist in pi (the directory is the spawn's), `-r` opens an interactive
// picker instead of taking a path, and a session child without `--approve`
// silently loads none of the project's own extensions, skills or prompt
// templates.
// ---------------------------------------------------------------------------
assert.deepEqual(spawnArgs({}), ["--mode", "rpc", "--approve"]);
assert.deepEqual(
	spawnArgs({ file: "/s/x.jsonl", model: "anthropic/claude-opus-5", personality: "/p.md" }),
	[
		"--mode",
		"rpc",
		"--approve",
		"--session",
		"/s/x.jsonl",
		"--model",
		"anthropic/claude-opus-5",
		"--append-system-prompt",
		"/p.md",
	],
);

// ---------------------------------------------------------------------------
// Framing
//
// LF is the only record delimiter pi guarantees, and a frame can be a
// megabyte of UTF-8 split across arbitrary chunk boundaries.
// ---------------------------------------------------------------------------
{
	const seen: Record<string, unknown>[] = [];
	const errors: string[] = [];
	const reader = new FrameReader(
		(f) => seen.push(f),
		(m) => errors.push(m),
	);

	// A multi-byte character straddling a chunk boundary must survive, which
	// is why the split is on bytes and the decode is per whole line.
	const frame = Buffer.from(`${JSON.stringify({ type: "x", text: "héllo →" })}\n`, "utf8");
	reader.push(frame.subarray(0, 12));
	reader.push(frame.subarray(12));
	assert.equal(seen.length, 1);
	assert.equal(seen[0].text, "héllo →");

	// CRLF input: one trailing CR is stripped, as the protocol asks.
	reader.push(Buffer.from(`${JSON.stringify({ type: "y" })}\r\n`, "utf8"));
	assert.equal(seen[1].type, "y");

	// U+2028 is legal inside a JSON string and must NOT split a record —
	// this is exactly why Node's readline is not usable here.
	reader.push(Buffer.from(`${JSON.stringify({ type: "z", text: "a\u2028b" })}\n`, "utf8"));
	assert.equal(seen[2].text, "a\u2028b");
	assert.deepEqual(errors, []);

	// Garbage is reported and reading continues: one bad line must not stop
	// the session that follows it.
	reader.push(Buffer.from("not json\n", "utf8"));
	reader.push(Buffer.from('{"type":"after"}\n', "utf8"));
	assert.equal(errors.length, 1);
	assert.equal(seen[3].type, "after");
}

// ---------------------------------------------------------------------------
// One real turn, replayed
//
// fixtures/pi-turn.jsonl is a verbatim transcript of `pi --mode rpc` running
// a prompt that used the `read` and `bash` tools (pi 0.85.1). Replaying it is
// the only check that keeps the event mapping honest across a pi upgrade.
// ---------------------------------------------------------------------------
const frames = readFileSync(join(here, "fixtures", "pi-turn.jsonl"), "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Record<string, unknown>);

const events: PiEvent[] = frames.flatMap(toEvents);

assert.deepEqual(
	events.map((e) => e.type),
	[
		// The user turn is persisted and echoed back before anything streams.
		"message_done",
		"thinking",
		// The assistant message carrying both tool calls.
		"message_done",
		"tool_start",
		"tool_start",
		"tool_update",
		"tool_update",
		"tool_end",
		"tool_end",
		// One settled toolResult message each.
		"message_done",
		"message_done",
		"text",
		"text",
		"message_done",
		"idle",
	],
	"the event sequence of one read+bash turn",
);

// `agent_end` is NOT idle in pi: a retry, a compaction retry or a queued
// message may follow it. Exactly one `agent_settled` is, and it is last.
assert.equal(events.filter((e) => e.type === "idle").length, 1, "exactly one idle");
assert.equal(events.at(-1)?.type, "idle", "idle is the last thing that happens");

// The streamed text is assembled from deltas, because pi sends no cumulative
// snapshot on `message_update` at all.
const streamed = events
	.filter((e): e is Extract<PiEvent, { type: "text" }> => e.type === "text")
	.map((e) => e.delta)
	.join("");
assert.equal(streamed, "fennel", "text deltas concatenate to the answer");

const starts = events.filter((e): e is Extract<PiEvent, { type: "tool_start" }> => e.type === "tool_start");
assert.deepEqual(
	starts.map((e) => e.name),
	["read", "bash"],
	"both tool calls are announced, in call order",
);

// `partialResult` is cumulative, so a consumer replaces rather than appends;
// the final `tool_end` result must therefore be a superset, not a duplicate.
const bashEnd = events.find(
	(e): e is Extract<PiEvent, { type: "tool_end" }> => e.type === "tool_end" && e.name === "bash",
);
assert.equal(bashEnd?.isError, false);
assert.equal(bashEnd?.result.trim(), "hi");

// ---------------------------------------------------------------------------
// Event mapping, one frame at a time
// ---------------------------------------------------------------------------

// A failed turn produces NO error frame: pi reports a provider failure as an
// assistant message with stopReason "error" and an errorMessage. Without this
// the UI renders a blank message and never learns anything went wrong.
assert.deepEqual(
	toEvents({
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "overloaded",
			errorStatus: 529,
		},
	}),
	[{ type: "error", message: "overloaded (HTTP 529)" }],
);

// An extension's `notify` is fire-and-forget and is the ONLY output an
// extension command produces — dropping it makes such a command look like it
// never ran.
assert.deepEqual(
	toEvents({
		type: "extension_ui_request",
		id: "u1",
		method: "notify",
		message: "probe pong",
		notifyType: "warning",
	}),
	[{ type: "notice", notice: { level: "warning", text: "probe pong" } }],
);

// Display-only requests expect no response and have nowhere to go here.
assert.deepEqual(toEvents({ type: "extension_ui_request", id: "u2", method: "setWidget" }), []);

// Retries are not turn failures, but the user is owed the reason their answer
// is late.
assert.deepEqual(
	toEvents({
		type: "auto_retry_start",
		attempt: 1,
		maxAttempts: 3,
		delayMs: 2000,
		errorMessage: "529 overloaded",
	}),
	[{ type: "notice", notice: { level: "warning", text: "retry 1/3 in 2s: 529 overloaded" } }],
);

/*
 * pi 0.86 persists the system prompt as a `system` message at the head of
 * every session — `content: ""`, the real text under `sections` — and
 * `get_messages` hands it back. Rendered, it is a blank row above the first
 * thing anybody said, which is what a 0.86.0 machine showed while the hub
 * was still on 0.85.1.
 */
const systemMessage = {
	role: "system",
	content: "",
	sections: { preamble: "You are an expert coding assistant operating inside pi…" },
	timestamp: 3,
};
assert.equal(isConversation(systemMessage), false);
assert.equal(isConversation({ role: "user", content: "hi" }), true);
assert.deepEqual(toEvents({ type: "message_end", message: systemMessage }), []);

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const assistant = (id: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
	timestamp: 1,
});
const result = (id: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text: "ok" }],
	timestamp: 2,
});

// Answered call: untouched.
assert.deepEqual(healDanglingToolCalls([assistant("a"), result("a")]), [assistant("a"), result("a")]);

// Dangling call: a synthetic error result is inserted right after it. Without
// it the provider rejects every later prompt in this session ("tool_use ids
// were found without tool_result blocks") and the file is bricked, not the
// turn.
const healed = healDanglingToolCalls([assistant("a"), { role: "user", content: "proceed" }]);
assert.equal(healed.length, 3);
assert.equal(healed[1].role, "toolResult");
assert.equal(healed[1].toolCallId, "a");
assert.equal(healed[1].isError, true);
assert.equal(healed[2].role, "user");

// A tool call answered out of order is still answered: the result may be
// persisted after an unrelated message, and inserting a second synthetic
// result would replay two results for one call.
const outOfOrder = healDanglingToolCalls([
	assistant("a"),
	{ role: "user", content: "proceed" },
	result("a"),
]);
assert.equal(outOfOrder.length, 3);
assert.equal(outOfOrder.filter((m) => m.role === "toolResult").length, 1);

// A compaction boundary must arrive with its text: the summary lives in
// `summary`, and reading `content` rendered the boundary as an empty row.
const compacted = toPiMessage({
	role: "compactionSummary",
	summary: "## Goal\nShip the thing.",
	timestamp: 7,
});
assert.equal(compacted.role, "compaction");
assert.deepEqual(compacted.blocks, [{ kind: "text", text: "## Goal\nShip the thing." }]);

// Same field, different entry: a branch summary is not a boundary, but it is
// still text and must not come through blank either.
const branch = toPiMessage({ role: "branchSummary", summary: "abandoned the retry idea", timestamp: 8 });
assert.equal(branch.role, "other");
assert.deepEqual(branch.blocks, [{ kind: "text", text: "abandoned the retry idea" }]);

// A resumed session's images have to survive the round trip, or the
// transcript loses the thing the question was about.
const withImage = toPiMessage({
	role: "user",
	content: [
		{ type: "image", data: "AAA", mimeType: "image/png" },
		{ type: "text", text: "what is this?" },
	],
	timestamp: 9,
});
assert.deepEqual(withImage.blocks, [
	{ kind: "image", data: "AAA", mimeType: "image/png" },
	{ kind: "text", text: "what is this?" },
]);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
// pi nests paths and scopes under `sourceInfo`; none of it belongs in a
// two-line picker row, and a command with no name would be a row that
// inserts nothing.
assert.deepEqual(
	toCommands([
		{
			name: "skill:greeter",
			description: "greet politely",
			source: "skill",
			sourceInfo: { path: "/p/.pi/skills/greeter/SKILL.md", scope: "project" },
		},
		{ description: "nameless", source: "extension" },
	]),
	[{ name: "skill:greeter", description: "greet politely", source: "skill" }],
);

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
assert.deepEqual(toAsk({ id: "u1", method: "select", title: "Pick", options: ["A", "B"] }), {
	id: "u1",
	kind: "select",
	title: "Pick",
	message: undefined,
	options: [{ label: "A" }, { label: "B" }],
});

// A picker with nothing to pick cannot be answered, and rendering one would
// be a dead end the turn never leaves.
assert.equal(toAsk({ id: "u2", method: "select", options: [] }), null);

// `editor` prefills and takes paragraphs; `input` only hints, and typing its
// placeholder into the field would submit text the user never wrote.
const editor = toAsk({ id: "u3", method: "editor", title: "Edit", prefill: "line 1\nline 2" });
assert.equal(editor?.kind, "text");
assert.equal(editor?.multiline, true);
assert.equal(editor?.value, "line 1\nline 2");
const input = toAsk({ id: "u4", method: "input", placeholder: "type something" });
assert.equal(input?.multiline, false);
assert.equal(input?.value, undefined);

// Display-only methods expect NO response; answering one would post a reply
// to a frame pi is not waiting on.
assert.equal(toAsk({ id: "u5", method: "setWidget" }), null);
assert.equal(toAsk({ id: "u6", method: "notify", message: "done" }), null);

console.log("ok");
