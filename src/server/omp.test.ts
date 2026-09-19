// Run: node --import tsx src/server/omp.test.ts
import assert from "node:assert/strict";
import { healDanglingToolCalls, toAsk, toPiMessage } from "./omp.js";

const assistant = (id: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash" }],
	timestamp: 1,
});
const result = (id: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [],
	isError: false,
});

// Answered call: untouched.
assert.deepEqual(healDanglingToolCalls([assistant("a"), result("a")]), [assistant("a"), result("a")]);

// Dangling call: a synthetic error result is inserted right after it.
const healed = healDanglingToolCalls([assistant("a"), { role: "user", content: "proceed" }]);
assert.equal(healed.length, 3);
assert.equal(healed[1].role, "toolResult");
assert.equal(healed[1].toolCallId, "a");
assert.equal(healed[1].isError, true);
assert.equal(healed[2].role, "user");

// A tool call answered out of order is still answered: the result may be
// persisted after an unrelated message, and inserting a second synthetic
// result would replay two results for one call and break the provider request.
const outOfOrder = healDanglingToolCalls([
	assistant("a"),
	{ role: "user", content: "proceed" },
	result("a"),
]);
assert.equal(outOfOrder.length, 3);
assert.equal(outOfOrder.filter((m) => m.role === "toolResult").length, 1);

/*
 * A compaction boundary must arrive with its text. omp puts a summary's text
 * in `summary` and gives the message NO `content` field at all (verified
 * against get_messages), so reading content rendered the boundary as an empty
 * row — a session that looked like it had lost its history to nothing.
 */
const compacted = toPiMessage({
	role: "compactionSummary",
	summary: "## Goal\nShip the thing.",
	shortSummary: "shipped",
	tokensBefore: 22522,
	timestamp: 7,
});
assert.equal(compacted.role, "compaction");
assert.deepEqual(compacted.blocks, [{ kind: "text", text: "## Goal\nShip the thing." }]);

// Same field, different entry: a branch summary is not a boundary, but it is
// still text and must not come through blank either.
const branch = toPiMessage({ role: "branchSummary", summary: "abandoned the retry idea", timestamp: 8 });
assert.equal(branch.role, "other");
assert.deepEqual(branch.blocks, [{ kind: "text", text: "abandoned the retry idea" }]);

/*
 * `optionDetails` is POSITIONAL and omp only sends it when some option has a
 * description, so an off-by-one here would attach "needs a server" to SQLite
 * — a wrong description on a decision the user is making from this panel.
 */
const select = toAsk({
	id: "u1",
	method: "select",
	title: "Which storage backend?",
	options: ["SQLite", "PostgreSQL"],
	optionDetails: [{}, { description: "needs a server" }],
});
assert.deepEqual(select, {
	id: "u1",
	kind: "select",
	title: "Which storage backend?",
	message: undefined,
	options: [
		{ label: "SQLite", description: undefined },
		{ label: "PostgreSQL", description: "needs a server" },
	],
});

// A picker with nothing to pick cannot be answered, and rendering one would be
// a dead end the turn never leaves.
assert.equal(toAsk({ id: "u2", method: "select", options: [] }), null);

// `editor` is the follow-up to a picker's "Other", and its answer is free
// text: collapsing it to a one-line field would make Enter submit a paragraph
// halfway through.
const editor = toAsk({ id: "u3", method: "editor", title: "Enter your response:" });
assert.equal(editor?.kind, "text");
assert.equal(editor?.multiline, true);
assert.equal(toAsk({ id: "u4", method: "input" })?.multiline, false);

// Display-only methods expect NO response; answering them would post a reply
// to a frame omp is not waiting on.
assert.equal(toAsk({ id: "u5", method: "setWidget" }), null);
assert.equal(toAsk({ id: "u6", method: "notify", message: "done" }), null);

console.log("ok");
