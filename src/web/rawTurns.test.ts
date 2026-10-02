import assert from "node:assert/strict";
import { test } from "node:test";
import { rawRows } from "./rawTurns.js";

test("only the final answer stays outside one work group per turn", () => {
	const rows = rawRows([
		{ role: "user", timestamp: 1, blocks: [{ kind: "text", text: "question" }] },
		{ role: "assistant", timestamp: 2, blocks: [{ kind: "text", text: "intermediate" }, { kind: "tool", id: "a", name: "read", args: {} }] },
		{ role: "assistant", timestamp: 3, blocks: [{ kind: "thinking", text: "reasoning" }, { kind: "text", text: "**final**" }] },
		{ role: "user", timestamp: 4, blocks: [{ kind: "text", text: "next" }] },
		{ role: "assistant", timestamp: 5, blocks: [{ kind: "text", text: "second answer" }] },
	], { text: "", thinking: "", tools: [] }, false);
	assert.equal(rows.length, 4);
	assert.deepEqual(rows[1].blocks, [{ kind: "text", text: "**final**" }]);
	assert.equal(rows[1].work?.length, 3);
	assert.equal(rows[3].work?.length, 0);
	assert.deepEqual(rows[3].blocks, [{ kind: "text", text: "second answer" }]);
});


test("final answer text and images stay outside work without mutating the source messages", () => {
	const messages = [{
		role: "assistant" as const, timestamp: 4000,
		blocks: [
			{ kind: "thinking" as const, text: "Conclusion" },
			{ kind: "text" as const, text: "Final answer" },
			{ kind: "image" as const, data: "image", mimeType: "image/png" },
		],
	}];
	const rows = rawRows(messages, { text: "", thinking: "", tools: [] }, false);
	assert.deepEqual(rows[0].work?.map((b) => b.kind), ["thinking"]);
	assert.deepEqual(rows[0].blocks.map((b) => b.kind), ["text", "image"]);
	assert.equal(rows[0].answerAt, 4000, "fork must target the assistant, not the prompt");
	assert.equal(messages[0].blocks.length, 3);
	const live = rawRows(messages, { text: "", thinking: "", tools: [] }, true);
	assert.equal(live[0].blocks.length, 0, "streaming prose is not a settled answer");
	assert.equal(live[0].answerAt, undefined);
});

test("work timing uses measured activity, with message end times as a fallback", () => {
	const messages = [
		{ role: "user" as const, timestamp: 1000, blocks: [] },
		{ role: "assistant" as const, timestamp: 2000, endedAt: 14000, blocks: [{ kind: "thinking" as const, text: "work" }, { kind: "text" as const, text: "answer" }] },
		{ role: "user" as const, timestamp: 90000, blocks: [] },
	];
	const partial = { text: "", thinking: "", tools: [] };
	const fallback = rawRows(messages, partial, false)[1];
	assert.equal(fallback.workStartedAt, 1000);
	assert.equal(fallback.workEndedAt, 14000, "idle time until the next prompt is excluded");
	const activity = [{ asked: 1000, start: 1500, end: 13500, steps: [], tools: [] }];
	const measured = rawRows(messages, partial, false, activity)[1];
	assert.equal(measured.workStartedAt, 1500);
	assert.equal(measured.workEndedAt, 13500);
	const live = rawRows(messages.slice(0, 2), partial, true, activity)[1];
	assert.equal(live.workEndedAt, undefined);
	const untimed = rawRows([{ ...messages[1], endedAt: undefined }], partial, false)[0];
	assert.equal(untimed.workEndedAt, undefined, "old history must not invent a duration");
});
