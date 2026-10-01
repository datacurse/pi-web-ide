import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityBreakdown, CompletedActivity, TurnStatus } from "./Activity.js";
import type { TurnActivity } from "../shared/activity.js";

const activity: TurnActivity = {
	start: 1000, asked: 1000, lastOutputAt: 4000,
	steps: [
		{ kind: "preparing", label: "Preparing request", start: 1000, end: 1100 },
		{ kind: "request", label: "Sending request / waiting for provider response", start: 1100, end: 2000 },
		{ kind: "response", label: "Response received · waiting for model output", start: 2000, end: 4000 },
		{ kind: "text", label: "Receiving answer", start: 4000 },
	], tools: [],
};

test("live status shows the actual phase, phase time, total time, and honest stream silence", (t) => {
	t.mock.method(Date, "now", () => 10000);
	const html = renderToStaticMarkup(createElement(TurnStatus, { activity }));
	assert.match(html, /Receiving answer/);
	assert.match(html, /6\.0s/);
	assert.match(html, /Total/);
	assert.match(html, /9\.0s/);
	assert.match(html, /No new output for/);
	assert.match(html, /aria-expanded="false"/);
	assert.doesNotMatch(html, /Honking|Ruminating/);
});

test("waiting for the provider is not labelled thinking, and input waits override concurrent output", (t) => {
	t.mock.method(Date, "now", () => 5000);
	const waiting = { ...activity, steps: activity.steps.slice(0, 2).map((step) => ({ ...step, end: undefined })) };
	const html = renderToStaticMarkup(createElement(TurnStatus, { activity: waiting }));
	assert.match(html, /Sending request \/ waiting for provider response/);
	assert.doesNotMatch(html, /No new output for|Thinking/);
	assert.match(renderToStaticMarkup(createElement(TurnStatus, { activity, waitingForInput: true })), /Waiting for your input/);
});

test("breakdown preserves observed boundaries and completed durations do not grow after reload", () => {
	const completed: TurnActivity = { ...activity, end: 6000, steps: activity.steps.map((step) => ({ ...step, end: step.end ?? 6000 })) };
	const html = renderToStaticMarkup(createElement(ActivityBreakdown, { activity: completed, now: 999999 }));
	assert.match(html, /Turn timeline/);
	assert.match(html, /2\.0s/);
	assert.match(html, /provider processing and network delivery cannot be separated/);
	assert.doesNotMatch(html, /993\.9s|now/);
	assert.match(renderToStaticMarkup(createElement(CompletedActivity, { activity: completed })), /Timing.*5\.0s/);
});
