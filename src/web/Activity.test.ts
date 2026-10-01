import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, isValidElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as sharedActivity from "../shared/activity.js";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityBreakdown, ActivityHistory, ActivityPanel, CompletedActivity, TurnStatus } from "./Activity.js";
import { TurnWork } from "./TurnWork.js";
import { Tool } from "./Transcript.js";
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

test("the elapsed strip remains visible while timing is collapsed and marks the live segment without a completion percentage", (t) => {
	t.mock.method(Date, "now", () => 10000);
	const html = renderToStaticMarkup(createElement(ActivityPanel, { activity }));
	assert.match(html, /aria-expanded="false"/);
	assert.match(html, /Elapsed activity history, not completion progress/);
	assert.match(html, /aria-current="step"/);
	assert.match(html, /Requesting/);
	assert.match(html, /Receiving/);
	assert.doesNotMatch(html, /Turn timeline|role="progressbar"|aria-valuenow/);
	const later = renderToStaticMarkup(createElement(ActivityHistory, { activity, now: 13000, onSelect: () => {} }));
	assert.match(later, /flex-grow:9000/);
});

test("integrated work shows collapsed phases and failures without rendering a duplicate log or final answer", () => {
	const timed: TurnActivity = { start: 1000, end: 6000, steps: [
		{ kind: "request", label: "request", start: 1000, end: 2000 },
		{ kind: "thinking", label: "thinking", start: 2000, end: 3000 },
		{ kind: "tools", label: "read", start: 3000, end: 4000 },
		{ kind: "processing", label: "processing", start: 4000, end: 4100 },
		{ kind: "tools", label: "edit", start: 4100, end: 6000 },
	], tools: [{ id: "a", label: "read", start: 3000, end: 4000 }, { id: "b", label: "edit", start: 4100, end: 6000, isError: true }] };
	const html = renderToStaticMarkup(createElement(TurnWork, { activity: timed, messages: [{ role: "assistant", timestamp: 1000, blocks: [
		{ kind: "thinking", text: "Detailed reasoning" },
		{ kind: "tool", id: "a", name: "read", args: { path: "a.ts" }, result: "Private output" },
	] }] }));
	assert.equal((html.match(/<details/g) ?? []).length, 3);
	assert.doesNotMatch(html, /<details[^>]* open|Detailed reasoning|Private output/);
	assert.match(html, /2 tools/);
	assert.match(html, /1 failed/);
	assert.match(html, /Doing/);
	assert.match(html, /Turn timeline/);
	assert.equal((html.match(/Elapsed activity history, not completion progress/g) ?? []).length, 1);
	assert.match(renderToStaticMarkup(createElement(Tool, { name: "read", args: {}, result: "done", autoOpen: false, ms: 400 })), /0\.4s/);
});

function elements(value: unknown): ReactElement[] {
	if (Array.isArray(value)) return value.flatMap(elements);
	if (!isValidElement<{ children?: unknown }>(value)) return [];
	return [value, ...elements(value.props.children)];
}

test("selecting a history segment opens timing and the corresponding phase, then scrolls to it", () => {
	const require = createRequire(import.meta.url);
	const modules: Record<string, unknown> = {
		"react/jsx-runtime": require("react/jsx-runtime"),
		"@phosphor-icons/react": require("@phosphor-icons/react"),
	};
	const source = ts.transpileModule(readFileSync(new URL("./Activity.tsx", import.meta.url), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
	}).outputText;
	const slots: unknown[] = [];
	let cursor = 0;
	let headers: Map<number, HTMLDetailsElement> | undefined;
	const exports = {} as { ActivityPanel: typeof ActivityPanel; ActivityHistory: typeof ActivityHistory; ActivityBreakdown: typeof ActivityBreakdown };
	runInNewContext(source, {
		exports, requestAnimationFrame: (callback: () => void) => callback(),
		require(name: string) {
			if (name === "react") return {
				useState(initial: unknown) {
					const index = cursor++;
					if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
					return [slots[index], (value: unknown) => { slots[index] = value; }];
				},
				useRef(initial: Map<number, HTMLDetailsElement>) {
					const index = cursor++;
					if (!(index in slots)) slots[index] = { current: initial };
					headers = (slots[index] as { current: Map<number, HTMLDetailsElement> }).current;
					return slots[index];
				},
				useEffect() {},
			};
			if (name === "../shared/activity.js") return sharedActivity;
			if (name === "./i18n.js") return { t: (key: string) => key, plural: () => "tools" };
			if (name in modules) return modules[name];
			throw new Error(`Unexpected import: ${name}`);
		},
	});
	const render = () => { cursor = 0; return exports.ActivityPanel({ activity }); };
	const panel = render();
	const history = elements(panel).find((node) => node.type === exports.ActivityHistory);
	assert.ok(history);
	assert.ok(headers);
	let scrolled = false;
	const detail = { open: false, scrollIntoView() { scrolled = true; } } as HTMLDetailsElement;
	headers.set(3, detail);
	(history.props as { onSelect(id: number): void }).onSelect(3);
	assert.equal(detail.open, true);
	assert.equal(scrolled, true);
	assert.ok(elements(render()).some((node) => node.type === exports.ActivityBreakdown));
});
