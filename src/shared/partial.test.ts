import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyPartial, reducePartial } from "./partial.js";

test("deltas append but cumulative tool output replaces; input state is never mutated", () => {
	const initial = emptyPartial();
	const thinking = reducePartial(initial, { type: "thinking", delta: "Why" });
	const text = reducePartial(thinking, { type: "text", delta: "Answer" });
	assert.deepEqual(initial, emptyPartial());
	assert.equal(text.thinking, "Why");
	assert.equal(text.text, "Answer");
	const started = reducePartial(text, { type: "tool_start", id: "child", name: "read", args: {}, parentId: "batch", at: 1000 });
	const updated = reducePartial(started, { type: "tool_update", id: "child", result: "old output" });
	const latest = reducePartial(updated, { type: "tool_update", id: "child", result: "complete output" });
	assert.equal(started.tools[0].result, undefined);
	assert.equal(latest.tools[0].result, "complete output");
	const done = reducePartial(latest, { type: "tool_end", id: "child", name: "read", result: "done", isError: false, at: 1300 });
	assert.equal(done.tools[0].durationMs, 300);
	assert.equal(done.tools[0].running, false);
	assert.equal(latest.tools[0].running, true);
	assert.deepEqual(reducePartial(done, { type: "idle" }), emptyPartial());
	assert.deepEqual(reducePartial(done, { type: "message_done", message: { role: "assistant", timestamp: 1400, blocks: [] } }), emptyPartial());
});

test("unknown tool IDs cannot change retained tools, and clock skew does not yield negative durations", () => {
	const started = reducePartial(emptyPartial(), { type: "tool_start", id: "child", name: "read", args: {}, parentId: "batch", at: 1000 });
	const unknown = reducePartial(started, { type: "tool_end", id: "other", name: "read", result: "", isError: true });
	assert.deepEqual(unknown, started);
	const done = reducePartial(started, { type: "tool_end", id: "child", name: "read", result: "", isError: false, at: 900 });
	assert.equal(done.tools[0].durationMs, 0);
});
