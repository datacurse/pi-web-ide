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
