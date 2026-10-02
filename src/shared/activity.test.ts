import assert from "node:assert/strict";
import { test } from "node:test";
import { activityLabel, parseActivity, type TurnActivity } from "./activity.js";

const trace: TurnActivity = {
	start: 1000, asked: 900, end: 2000, lastOutputAt: 1800,
	steps: [
		{ kind: "request", label: "Waiting for model output", start: 1000, end: 1500 },
		{ kind: "tools", label: "Running tools", start: 1500, end: 2000 },
	],
	tools: [
		{ id: "a", label: "read", start: 1500, end: 1800 },
		{ id: "b", label: "edit", start: 1600, end: 1900, isError: true },
	],
};

test("saved activity accepts contiguous steps and overlapping parallel tools", () => {
	assert.deepEqual(parseActivity(JSON.parse(JSON.stringify(trace))), trace);
	assert.equal(activityLabel("request"), "Waiting for model output");
});

test("live activity accepts an unfinished final step and tool", () => {
	const live = { ...trace, end: undefined, steps: [trace.steps[0], { ...trace.steps[1], end: undefined }], tools: [{ ...trace.tools[0], end: undefined }] };
	assert.equal(parseActivity(live), live);
});

test("malformed telemetry is rejected at the trust boundary", () => {
	const invalid = [
		null, [], {},
		{ ...trace, start: -1 },
		{ ...trace, end: 999 },
		{ ...trace, asked: NaN },
		{ ...trace, lastOutputAt: 2001 },
		{ ...trace, steps: [{ ...trace.steps[0], kind: "bogus" }] },
		{ ...trace, steps: [{ ...trace.steps[0], label: "x".repeat(241) }] },
		{ ...trace, steps: [trace.steps[0], { ...trace.steps[1], start: 1600 }] },
		{ ...trace, steps: [trace.steps[0], { ...trace.steps[1], end: undefined }] },
		{ ...trace, tools: [{ ...trace.tools[0], start: 999 }] },
		{ ...trace, tools: [{ ...trace.tools[0], end: 2001 }] },
		{ ...trace, tools: [{ ...trace.tools[0], isError: "yes" }] },
	];
	for (const value of invalid) assert.equal(parseActivity(value), undefined);
});
