import assert from "node:assert/strict";
import { test } from "node:test";
import { activityGroups, type ActivityKind, type TurnActivity } from "./activity.js";

function trace(kinds: ActivityKind[], live = false): TurnActivity {
	return {
		start: 1000, end: live ? undefined : 1000 + kinds.length * 100,
		steps: kinds.map((kind, i) => ({ kind, label: kind, start: 1000 + i * 100, end: live && i === kinds.length - 1 ? undefined : 1100 + i * 100 })),
		tools: [],
	};
}

test("ordinary subphases collapse into requesting, receiving and doing cycles", () => {
	const activity = trace(["processing", "preparing", "request", "response", "thinking", "text", "toolcall", "processing", "tools", "processing", "tools", "processing", "preparing", "request", "text"]);
	const groups = activityGroups(activity);
	assert.deepEqual(groups.map((g) => g.kind), ["requesting", "receiving", "doing", "requesting", "receiving"]);
	assert.deepEqual(groups.map((g) => g.end! - g.start), [400, 400, 400, 200, 100]);
	assert.equal(groups.reduce((ms, g) => ms + g.end! - g.start, 0), activity.end! - activity.start);
});

test("tiny and parallel tools share a doing group but retain individual durations and failures", () => {
	const activity = trace(["request", "text", "tools", "tools", "processing", "tools", "processing", "request"]);
	activity.tools = [
		{ id: "a", label: "read", start: 1200, end: 1600 },
		{ id: "b", label: "edit", start: 1300, end: 1400, isError: true },
		{ id: "c", label: "read", start: 1500, end: 1550 },
	];
	const group = activityGroups(activity).find((g) => g.kind === "doing")!;
	assert.equal(group.end! - group.start, 500);
	assert.deepEqual(group.tools.map((tool) => tool.id), ["a", "b", "c"]);
	assert.equal(group.tools[1].isError, true);
	assert.equal(group.steps.length, 5);
});

test("retry, compaction and input waits remain distinct rather than masquerading as normal work", () => {
	assert.deepEqual(activityGroups(trace(["request", "retry", "compaction", "request", "text", "tools", "input", "processing", "request"])).map((g) => g.kind),
		["requesting", "retry", "compaction", "requesting", "receiving", "doing", "input", "requesting"]);
});

test("a live group's identity stays stable as it grows, and completed groups keep their times", () => {
	const activity = trace(["request", "text", "tools"], true);
	const before = activityGroups(activity);
	activity.steps[2].end = 1500;
	activity.steps.push({ kind: "tools", label: "another tool", start: 1500 });
	const after = activityGroups(activity);
	assert.equal(after.at(-1)?.id, before.at(-1)?.id);
	assert.equal(after.at(-1)?.end, undefined);
	assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
});

test("a zero-duration call belongs to its doing phase, not the request beginning at the same instant", () => {
	const activity: TurnActivity = { start: 1000, end: 2000, steps: [
		{ kind: "tools", label: "read", start: 1000, end: 1000 },
		{ kind: "request", label: "request", start: 1000, end: 2000 },
	], tools: [{ id: "a", label: "read", start: 1000, end: 1000 }] };
	assert.equal(activityGroups(activity)[0].tools[0].id, "a");
});
