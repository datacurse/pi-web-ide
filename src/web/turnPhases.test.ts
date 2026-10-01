import assert from "node:assert/strict";
import { test } from "node:test";
import { activityGroups, type TurnActivity } from "../shared/activity.js";
import type { PiMessage } from "../shared/types.js";
import { partitionPhaseTurn, phaseBlocks } from "./turnPhases.js";

const activity: TurnActivity = { start: 1000, end: 7000, steps: [
	{ kind: "request", label: "request", start: 1000, end: 2000 },
	{ kind: "thinking", label: "thinking", start: 2000, end: 3000 },
	{ kind: "tools", label: "tools", start: 3000, end: 4000 },
	{ kind: "request", label: "request", start: 4000, end: 5000 },
	{ kind: "text", label: "text", start: 5000, end: 7000 },
], tools: [{ id: "a", label: "read a.ts", start: 3000, end: 4000 }] };

const messages: PiMessage[] = [
	{ role: "assistant", timestamp: 1000, blocks: [
		{ kind: "thinking", text: "Reasoning" },
		{ kind: "text", text: "I will read the file." },
		{ kind: "tool", id: "a", name: "read", args: { path: "a.ts" }, result: "Contents" },
	] },
	{ role: "assistant", timestamp: 4000, endedAt: 7000, blocks: [
		{ kind: "thinking", text: "Conclusion" },
		{ kind: "text", text: "Final answer" },
		{ kind: "image", data: "image", mimeType: "image/png" },
	] },
];

test("only the final answer escapes its phase fold; earlier prose and final reasoning remain grouped", () => {
	const { work, answer } = partitionPhaseTurn(messages, false);
	assert.deepEqual(work.map((m) => m.blocks.map((b) => b.kind)), [["thinking", "text", "tool"], ["thinking"]]);
	assert.deepEqual(answer?.blocks.map((b) => b.kind), ["text", "image"]);
	assert.equal(answer?.timestamp, 4000);
	assert.equal(answer?.endedAt, 7000);
	assert.equal(messages[1].blocks.length, 3, "partitioning does not mutate the transcript");
});

test("streaming prose does not prematurely become the final answer", () => {
	assert.deepEqual(partitionPhaseTurn(messages, true), { work: messages });
	assert.deepEqual(partitionPhaseTurn(messages.slice(0, 1), false), { work: messages.slice(0, 1) });
});

test("actual reasoning, intermediate prose and tools attach to the right phase without duplication", () => {
	const groups = activityGroups(activity);
	const { work } = partitionPhaseTurn(messages, false);
	const blocks = phaseBlocks(groups, work);
	assert.deepEqual(blocks.get(groups[0].id), []);
	assert.deepEqual(blocks.get(groups[1].id)?.map((b) => b.kind), ["thinking", "text"]);
	assert.deepEqual(blocks.get(groups[2].id)?.map((b) => b.kind), ["tool"]);
	assert.equal(blocks.get(groups[2].id)?.[0], messages[0].blocks[2]);
	assert.deepEqual(blocks.get(groups[4].id)?.map((b) => b.kind), ["thinking"]);
	assert.equal([...blocks.values()].flat().length, 4);
});

test("live reasoning and generated tool arguments are receiving until a tool execution is measured", () => {
	const groups = activityGroups(activity);
	const partial = { thinking: "New reasoning", text: "New commentary", tools: [{ id: "pending", name: "read", args: { path: "b.ts" } }] };
	const blocks = phaseBlocks(groups, [], partial);
	assert.deepEqual(blocks.get(groups[4].id)?.map((b) => b.kind), ["thinking", "text", "tool"]);
	groups[2].tools.push({ id: "pending", label: "read b.ts", start: 3200 });
	assert.deepEqual(phaseBlocks(groups, [], partial).get(groups[2].id)?.map((b) => b.kind), ["tool"]);
});
