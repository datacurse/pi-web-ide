import assert from "node:assert/strict";
import { test } from "node:test";
import { activityGroups, activityRounds, type ActivityKind, type TurnActivity } from "./activity.js";

function trace(kinds: ActivityKind[], live = false): TurnActivity {
	return {
		start: 1000, end: live ? undefined : 1000 + kinds.length * 100,
		steps: kinds.map((kind, i) => ({ kind, label: kind, start: 1000 + i * 100, end: live && i === kinds.length - 1 ? undefined : 1100 + i * 100 })),
		tools: [],
	};
}

test("ordinary subphases separate preparation from thinking and streamed reasoning", () => {
	const activity = trace(["processing", "preparing", "request", "response", "thinking", "text", "toolcall", "processing", "tools", "processing", "tools", "processing", "preparing", "request", "text"]);
	const groups = activityGroups(activity);
	assert.deepEqual(groups.map((g) => g.kind), ["requesting", "thinking", "receiving", "doing", "requesting", "thinking", "receiving"]);
	assert.deepEqual(groups.map((g) => g.end! - g.start), [200, 200, 400, 400, 100, 100, 100]);
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
		["thinking", "retry", "compaction", "thinking", "receiving", "doing", "input", "requesting", "thinking"]);
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

test("rounds group request/response/tool cycles without adding overlapping tool time", () => {
	const activity = trace(["preparing","request","response","thinking","tools","processing","preparing","request","text"]);
	activity.tools = [{id:"a",label:"read",start:1400,end:1550},{id:"b",label:"bash",start:1450,end:1580}];
	const rounds = activityRounds(activityGroups(activity));
	assert.equal(rounds.length,2);
	assert.deepEqual(rounds.map(r=>r.groups.map(g=>g.kind)),[["requesting","thinking","receiving","doing"],["requesting","thinking","receiving"]]);
	assert.deepEqual(rounds.map(r=>r.end! - r.start),[600,300]);
	assert.equal(rounds.reduce((sum,r)=>sum+r.end!-r.start,0),activity.end!-activity.start);
	assert.equal(rounds[0].groups.at(-1)?.tools.length,2);
});
test("retries before output stay in the same round, and a new request after work starts the next", () => {
	const rounds = activityRounds(activityGroups(trace(["preparing","request","retry","preparing","request","text","tools","compaction","preparing","request"])));
	assert.equal(rounds.length,2);
	assert.ok(rounds[0].groups.some(g=>g.kind === "retry"));
	assert.ok(rounds[0].groups.some(g=>g.kind === "compaction"));
});
test("live round IDs and completed timings survive growth and serialized telemetry", () => {
	const activity = trace(["request","text","tools","preparing","request"],true);
	const before = activityRounds(activityGroups(activity));
	activity.steps.at(-1)!.end = 1500;
	activity.steps.push({kind:"text",label:"answer",start:1500});
	const after = activityRounds(activityGroups(activity));
	assert.deepEqual(after[0],before[0]);
	assert.equal(after[1].id,before[1].id);
	assert.equal(after[1].end,undefined);
	assert.deepEqual(activityRounds(activityGroups(JSON.parse(JSON.stringify(activity)))),after);
	assert.deepEqual(activityRounds([]),[]);
	assert.deepEqual(activityRounds(activityGroups(trace(["text"]))).map(r=>r.groups.map(g=>g.kind)),[["receiving"]]);
});

test("a zero-duration call belongs to its doing phase, not the request beginning at the same instant", () => {
	const activity: TurnActivity = { start: 1000, end: 2000, steps: [
		{ kind: "tools", label: "read", start: 1000, end: 1000 },
		{ kind: "request", label: "request", start: 1000, end: 2000 },
	], tools: [{ id: "a", label: "read", start: 1000, end: 1000 }] };
	assert.equal(activityGroups(activity)[0].tools[0].id, "a");
});
