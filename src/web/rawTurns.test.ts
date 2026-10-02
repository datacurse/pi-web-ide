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

test("todos stay with their turn while the current turn updates live", () => {
	const task = { id: 1, subject: "Implement", status: "pending" as const };
	const rows = rawRows([
		{ role: "user", timestamp: 1, blocks: [] },
		{ role: "assistant", timestamp: 2, blocks: [{ kind: "tool", id: "t", name: "todo", args: {}, todos: [task] }] },
		{ role: "user", timestamp: 3, blocks: [] },
	], { text: "", thinking: "", tools: [{ id: "live", name: "todo", args: {}, todos: [{ ...task, status: "completed" }] }] }, true);
	assert.deepEqual(rows[1].todos, [task]);
	assert.equal(rows[3].todos?.[0].status, "completed");
	const next = rawRows([
		{ role: "user", timestamp: 1, blocks: [] },
		{ role: "assistant", timestamp: 2, blocks: [{ kind: "tool", id: "t", name: "todo", args: {}, todos: [task] }] },
		{ role: "user", timestamp: 3, blocks: [] },
		{ role: "assistant", timestamp: 4, blocks: [{ kind: "text", text: "No tasks this turn" }] },
	], { text: "", thinking: "", tools: [] }, false);
	assert.deepEqual(next[3].todos, []);
});

test("saved nested updates use the earlier task state without rewriting old turns", () => {
	const rows = rawRows([
		{ role: "user", timestamp: 1, blocks: [] },
		{ role: "assistant", timestamp: 2, blocks: [{ kind: "tool", id: "t", name: "todo", args: {}, todos: [{ id: 1, subject: "Implement", status: "pending" }] }] },
		{ role: "user", timestamp: 3, blocks: [] },
		{ role: "assistant", timestamp: 4, blocks: [{ kind: "tool", id: "c", name: "codemode", args: {}, children: [{ id: "c/1", name: "todo", args: { action: "update", id: 1, status: "completed" }, outputUnavailable: true }] }] },
	], { text: "", thinking: "", tools: [] }, false);
	assert.equal(rows[1].todos?.[0].status, "pending");
	assert.equal(rows[3].todos?.[0].status, "completed");
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
