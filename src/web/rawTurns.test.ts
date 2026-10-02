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
