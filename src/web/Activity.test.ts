import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, isValidElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as sharedActivity from "../shared/activity.js";
import { renderToStaticMarkup } from "react-dom/server";
import { Brain, ArrowUpRight } from "@phosphor-icons/react";
import { ActivityBreakdown, ActivityHistory, ActivityPanel, CompletedActivity, PhaseIcon, TurnStatus } from "./Activity.js";
import { TurnWork, RoundWork } from "./TurnWork.js";
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
	assert.match(html, /aria-expanded="true"/);
	assert.doesNotMatch(html, /Honking|Ruminating/);
});

test("waiting is labelled Thinking with its measurement caveat, and input waits still override it", (t) => {
	t.mock.method(Date, "now", () => 5000);
	const waiting = { ...activity, steps: activity.steps.slice(0, 2).map((step) => ({ ...step, end: undefined })) };
	const html = renderToStaticMarkup(createElement(TurnStatus, { activity: waiting }));
	assert.match(html, /role="status">Thinking</);
	assert.match(html, /not isolated thinking time/);
	assert.match(html, /text-pink-400/);
	assert.doesNotMatch(html, /No new output for/);
	assert.match(renderToStaticMarkup(createElement(TurnStatus, { activity, waitingForInput: true })), /Waiting for your input/);
});

test("Requesting and Thinking have separate icons and measured preparation/wait durations", () => {
	assert.equal(PhaseIcon({kind:"requesting"}).type, ArrowUpRight);
	assert.equal(PhaseIcon({kind:"thinking"}).type, Brain);
	assert.match(renderToStaticMarkup(PhaseIcon({kind:"thinking"})), /text-pink-400/);
	const html = renderToStaticMarkup(createElement(ActivityBreakdown,{activity,now:6000}));
	assert.match(html,/Thinking/);
	assert.match(html,/not isolated thinking time/);
	assert.match(html,/2\.9s/);
	assert.match(html,/100ms/);
	assert.match(html,/Requesting/);
	assert.match(html,/Browser delivery and exact upload completion are not measured/);
});
test("compact live round legends retain the pink Thinking label and total duration", () => {
	const waiting = {...activity,steps:activity.steps.slice(0,3).map((step,i)=>({...step,end:i === 2 ? undefined : step.end}))};
	const html = renderToStaticMarkup(createElement(ActivityBreakdown,{activity:waiting,now:4000}));
	assert.match(html,/Round 1/);
	assert.match(html,/class="flex items-center gap-1 text-pink-400"/);
	assert.match(html,/3\.0s/);
	assert.match(html,/<details[^>]* open/);
});

test("streamed reasoning is still Receiving, not an additional waiting phase", () => {
	const streaming: TurnActivity = {...activity,steps:[...activity.steps.slice(0,3),{kind:"thinking",label:"Receiving reasoning",start:4000}]};
	const html = renderToStaticMarkup(createElement(TurnStatus,{activity:streaming}));
	assert.match(html,/role="status">Receiving reasoning</);
	assert.match(html,/text-green-400/);
});

test("breakdown preserves observed boundaries and completed durations do not grow after reload", () => {
	const completed: TurnActivity = { ...activity, end: 6000, steps: activity.steps.map((step) => ({ ...step, end: step.end ?? 6000 })) };
	const html = renderToStaticMarkup(createElement(ActivityBreakdown, { activity: completed, now: 999999 }));
	assert.match(html, /Turn timeline/);
	assert.match(html, /2\.0s/);
	assert.match(html, /not isolated thinking time/);
	assert.doesNotMatch(html, /993\.9s|aria-current="step"/);
	assert.match(renderToStaticMarkup(createElement(CompletedActivity, { activity: completed })), /Timing.*5\.0s/);
});

test("the elapsed strip remains visible while timing is collapsed and marks the live segment without a completion percentage", (t) => {
	t.mock.method(Date, "now", () => 10000);
	const html = renderToStaticMarkup(createElement(ActivityPanel, { activity, expandedByDefault:false }));
	assert.match(html, /aria-expanded="false"/);
	assert.match(html, /Elapsed activity history, not completion progress/);
	assert.match(html, /aria-current="step"/);
	assert.match(html, /Thinking/);
	assert.match(html, /bg-pink-400\/60/);
	assert.match(html, /Receiving/);
	assert.doesNotMatch(html, /Turn timeline|role="progressbar"|aria-valuenow/);
	const later = renderToStaticMarkup(createElement(ActivityHistory, { activity, now: 13000, onSelect: () => {} }));
	assert.match(later, /flex-grow:9000/);
});

test("integrated work starts expanded and preserves failures without a duplicate transcript", () => {
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
	assert.equal((html.match(/<details/g) ?? []).length, 1);
	assert.match(html,/Round 1/);
	assert.match(html, /<details[^>]* open/);
	assert.match(html,/Detailed reasoning/);
	assert.match(html,/Private output/);
	assert.match(html, /2 tools/);
	assert.match(html, /1 failed/);
	assert.match(html, /Doing/);
	assert.match(html, /Turn timeline/);
	assert.equal((html.match(/Elapsed activity history, not completion progress/g) ?? []).length, 1);
	assert.match(renderToStaticMarkup(createElement(Tool, { name: "read", args: {}, result: "done", autoOpen: false, ms: 400 })), /400ms/);
});

function elements(value: unknown): ReactElement[] {
	if (Array.isArray(value)) return value.flatMap(elements);
	if (!isValidElement<{ children?: unknown }>(value)) return [];
	return [value, ...elements(value.props.children)];
}

test("each round has one thin label-free bar beside its name, not empty phase disclosures", () => {
	const completed = {...activity,end:6000,steps:activity.steps.map(step=>({...step,end:step.end??6000}))};
	const html = renderToStaticMarkup(createElement(ActivityBreakdown,{activity:completed,now:6000}));
	assert.equal((html.match(/<details/g)??[]).length,1);
	assert.match(html,/Round step timings, not completion progress/);
	assert.match(html,/Requesting/);
	assert.match(html,/Thinking/);
	assert.match(html,/Receiving/);
	assert.match(html,/100ms/);
	assert.match(html,/2\.9s/);
	assert.doesNotMatch(html,/Sending request|Processing between requests|Preparing request|role="progressbar"/);
	assert.match(html,/flex h-2/);
	const start = html.indexOf('role="group"');
	const bar = html.slice(html.indexOf(">",start)+1,html.indexOf("</div>",start));
	assert.ok(bar.length > 0);
	assert.doesNotMatch(bar,/<svg/);
	assert.equal(bar.replace(/<[^>]*>/g,"").trim(),"");
	assert.ok(html.indexOf("Round 1") < html.indexOf("flex h-2"));
});
test("round body shows received prose before flat tool calls, without phase or codemode folds", () => {
	const timed: TurnActivity = {start:1000,end:6000,steps:[
		{kind:"preparing",label:"preparing",start:1000,end:1100},
		{kind:"request",label:"Sending request / waiting for provider response",start:1100,end:2000},
		{kind:"text",label:"text",start:2000,end:3000},
		{kind:"tools",label:"tools",start:3000,end:6000},
	],tools:[{id:"batch",label:"codemode",start:3000,end:6000},{id:"batch/1",label:"read: a.ts",start:3000,end:3120}]};
	const round = sharedActivity.activityRounds(sharedActivity.activityGroups(timed))[0];
	const html = renderToStaticMarkup(createElement(RoundWork,{round,now:6000,expandedByDefault:false,blocks:[
		{kind:"tool",id:"batch",name:"codemode",args:{code:"hidden script"},result:"hidden aggregate",children:[
			{id:"batch/1",name:"read",args:{path:"a.ts"},result:"body",durationMs:120},
		]},
		{kind:"text",text:"Received prose"},
	]}));
	assert.ok(html.indexOf("Received prose") < html.indexOf("a.ts"));
	assert.match(html,/a\.ts/);
	assert.match(html,/120ms/);
	assert.doesNotMatch(html,/<details|border-l|hidden script|hidden aggregate|Sending request/);
	assert.equal((html.match(/aria-expanded="false"/g)??[]).length,1);
	const header = renderToStaticMarkup(createElement(ActivityBreakdown,{activity:timed,now:6000}));
	assert.match(header,/1 tool/);
	assert.doesNotMatch(header,/2 tools/);
});

test("selecting a history segment opens timing and the corresponding round, then scrolls to it", () => {
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
	const refs: Map<number, HTMLDetailsElement>[] = [];
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
					refs.push(headers);
					return slots[index];
				},
				useEffect() {},
			};
			if (name === "../shared/activity.js") return sharedActivity;
			if (name === "./i18n.js") return { t: (key: string) => key, plural: () => "tools" };
			if (name === "./prefs.js") return { readWorkExpanded: () => false };
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
	refs[0].set(0,detail);
	(history.props as { onSelect(id: number): void }).onSelect(3);
	assert.equal(detail.open, true);
	assert.equal(scrolled, true);
	assert.ok(elements(render()).some((node) => node.type === exports.ActivityBreakdown));
});
