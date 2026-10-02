import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PiBlock, PiTool } from "../shared/types.js";
import type { TurnActivity } from "../shared/activity.js";
import { currentWorkStatus, explorationLabel, toolDescription, workTimeline } from "./workTimeline.js";
import { WorkTimeline } from "./WorkTimeline.js";

const tool = (id: string, name = "read", args: unknown = { path: "core.py" }): PiTool => ({ id, name, args });
const trace: TurnActivity = {
	start: 1000, asked: 1000, end: 6000,
	steps: [
		{ kind: "thinking", label: "", start: 1000, end: 3000 },
		{ kind: "text", label: "", start: 3000, end: 4000 },
		{ kind: "tools", label: "", start: 4000, end: 5000 },
		{ kind: "thinking", label: "", start: 5000, end: 6000 },
	],
	tools: [],
};
const blocks: PiBlock[] = [
	{ kind: "thinking", text: "Initial reasoning" },
	{ kind: "text", text: "I’ll inspect the checkpoint." },
	{ kind: "tool", ...tool("a") },
	{ kind: "thinking", text: "Check the caller too" },
	{ kind: "tool", ...tool("b", "anchor_grep", { pattern: "save_state" }) },
];

test("thinking, prose, and grouped exploration keep chronological order", () => {
	const items = workTimeline(blocks, trace, false);
	assert.deepEqual(items.map((item) => item.kind), ["thought", "prose", "tools"]);
	assert.equal(items[0].kind === "thought" && items[0].durationMs, 2000);
	const exploration = items[2];
	assert.equal(exploration.kind, "tools");
	if (exploration.kind !== "tools") return;
	assert.deepEqual(exploration.entries.map((entry) => entry.kind), ["tool", "thought", "tool"]);
	assert.equal(exploration.entries[1].kind === "thought" && exploration.entries[1].durationMs, 1000);
	assert.equal(explorationLabel(exploration.blocks, false), "Explored 1 file, 1 search");
	assert.equal(workTimeline(blocks, undefined, false)[0].kind === "thought", true);
	const untimed = workTimeline(blocks, { ...trace, steps: trace.steps.slice(0, 2) }, false)[0];
	assert.equal(untimed.kind === "thought" && untimed.durationMs, undefined);
});

test("status follows real events, including waiting, errors, and older servers", () => {
	assert.equal(currentWorkStatus(undefined, []), "Planning next moves");
	assert.equal(currentWorkStatus(undefined, [{ kind: "thinking", text: "Reason" }]), "Thinking");
	assert.equal(currentWorkStatus(undefined, [{ kind: "text", text: "Answer" }]), undefined);
	for (const [kind, expected] of [
		["processing", "Planning next moves"], ["request", "Planning next moves"],
		["thinking", "Thinking"], ["text", undefined], ["retry", "Waiting to retry"],
		["input", "Waiting for your input"], ["compaction", "Compacting conversation"],
		["tools", "Running tools"],
	] as const) {
		assert.equal(currentWorkStatus({ ...trace, end: undefined, steps: [{ kind, label: "", start: 1000 }] }, []), expected);
	}
	assert.equal(currentWorkStatus(undefined, [{ kind: "tool", ...tool("a"), running: true }]), undefined);
});

test("counts distinguish exploration from commands and do not double-count wrappers", () => {
	const nested = { ...tool("batch", "codemode"), children: [tool("a"), tool("b", "symbol_search", { query: "state" })] };
	assert.equal(explorationLabel([nested], true), "Exploring 1 file, 1 search");
	assert.equal(explorationLabel([tool("a", "bash", { command: "pnpm test" })], true), "Running 1 tool");
	assert.equal(explorationLabel([tool("a", "bash", { command: "rg checkpoint src" })], false), "Explored 1 search");
	assert.equal(toolDescription(tool("a", "read", { path: "core.py", offset: 90, limit: 140 })), "Read core.py L90–229");
	assert.equal(toolDescription(tool("b", "anchor_grep", { pattern: "<script>" })), "Searched <script>");
	assert.equal(explorationLabel([{ ...tool("bad"), isError: true }], false), "Explored 1 file · 1 failed");
	assert.equal(explorationLabel([{ ...tool("stopped"), interrupted: true }], false), "Explored 1 file · 1 interrupted");
});

test("rendering starts with planning, shows measured thoughts, and leaves prose visible", () => {
	const planning = renderToStaticMarkup(createElement(WorkTimeline, { blocks: [], running: true }));
	assert.match(planning, /role="status"[^>]*><span class="work-shimmer"[^>]*>Planning next moves<\/span>/);
	const html = renderToStaticMarkup(createElement(WorkTimeline, { blocks, activity: trace }));
	assert.match(html, /Thought 2s/);
	assert.match(html, /Explored 1 file, 1 search/);
	assert.doesNotMatch(html, /work-shimmer/);
	assert.match(html, /Thought 1s/);
	assert.ok(html.indexOf("Thought 2s") < html.indexOf("I’ll inspect"));
	assert.ok(html.indexOf("I’ll inspect") < html.indexOf("Explored"));
	assert.doesNotMatch(html, /<details[^>]* open/);
	assert.match(html, /group-hover\/label:opacity-100/);
	assert.match(html, /\[\[open\]&gt;summary&gt;&amp;\]:opacity-100/);
});

test("only executing exploration is active while thinking and planning follow sequentially", () => {
	const reasoning: PiBlock[] = [{ kind: "thinking", text: "Reasoning" }];
	const live = { ...trace, end: undefined, steps: [{ kind: "thinking" as const, label: "", start: 1000 }] };
	const html = renderToStaticMarkup(createElement(WorkTimeline, { blocks: reasoning, activity: live, running: true }));
	assert.equal((html.match(/>Thinking</g) ?? []).length, 1);
	assert.match(html, /class="work-shimmer"[^>]*>Thinking<\/span>/);
	const exploring = renderToStaticMarkup(createElement(WorkTimeline, { blocks: blocks.slice(0, -1), activity: live, running: true }));
	assert.match(exploring, /<span>Explored/);
	assert.doesNotMatch(exploring, /Exploring/);
	assert.match(exploring, /class="work-shimmer"[^>]*>Thinking<\/span>/);
	assert.equal((exploring.match(/class="work-shimmer"/g) ?? []).length, 1);
	const expanded = renderToStaticMarkup(createElement(WorkTimeline, { blocks: blocks.slice(0, -1), activity: live, running: true, expanded: true }));
	assert.equal((expanded.match(/class="work-shimmer"/g) ?? []).length, 1);
	const toolPhase = { ...live, steps: [{ kind: "tools" as const, label: "", start: 1000 }] };
	const tools = renderToStaticMarkup(createElement(WorkTimeline, { blocks: blocks.slice(0, -1), activity: toolPhase, running: true }));
	assert.match(tools, /class="work-shimmer"[^>]*>Exploring/);
	assert.equal((tools.match(/class="work-shimmer"/g) ?? []).length, 1);
	const planningPhase = { ...live, steps: [{ kind: "processing" as const, label: "", start: 1000 }] };
	const planning = renderToStaticMarkup(createElement(WorkTimeline, { blocks, activity: planningPhase, running: true }));
	assert.match(planning, /class="work-shimmer"[^>]*>Planning next moves/);
	assert.match(planning, /<span>Explored 1 file, 1 search/);
	assert.doesNotMatch(planning, /Exploring/);
	assert.equal((planning.match(/class="work-shimmer"/g) ?? []).length, 1);
	assert.doesNotMatch(html, /Thought 2s/);
	const items = workTimeline(blocks.slice(0, -1), live, true);
	const last = items.at(-1);
	assert.equal(last?.kind === "tools" && last.active, false);
	const done = renderToStaticMarkup(createElement(WorkTimeline, { blocks: reasoning, activity: trace }));
	assert.doesNotMatch(done, /role="status"/);
});

test("exploration follows real running flags, including nested and parallel calls", () => {
	const phase: TurnActivity = { ...trace, end: undefined, steps: [{ kind: "processing", label: "", start: 1000 }] };
	const active = (tools: PiBlock[], activity?: TurnActivity, running = true) => {
		const item = workTimeline(tools, activity, running).find((item) => item.kind === "tools");
		return item?.kind === "tools" && item.active;
	};
	const finished: PiBlock = { kind: "tool", ...tool("done"), running: false };
	const pending: PiBlock = { kind: "tool", ...tool("live"), running: true };
	assert.equal(active([finished]), false);
	assert.equal(active([finished], undefined), false);
	assert.equal(active([pending]), true);
	assert.equal(active([pending], undefined), true);
	assert.equal(active([pending], phase, false), false);
	assert.equal(active([pending, { kind: "text", text: "Other work" }]), true);
	const toolsPhase = { ...phase, steps: [{ kind: "tools" as const, label: "", start: 1000 }] };
	assert.equal(active([finished], toolsPhase), false);
	assert.equal(active([{ kind: "tool", ...tool("legacy") }], toolsPhase), true);
	assert.equal(active([{ kind: "tool", ...tool("batch", "codemode"), running: true, children: [tool("done")] }]), true);
	assert.equal(active([{ kind: "tool", ...tool("batch", "codemode"), children: [{ ...tool("child"), running: true }] }]), true);
});

test("empty thinking placeholders never become empty expandable disclosures", () => {
	const empty: PiBlock[] = [{ kind: "thinking", text: " \n\t" }];
	const untimed = renderToStaticMarkup(createElement(WorkTimeline, { blocks: empty }));
	assert.equal(untimed, "");
	const measured = { ...trace, steps: [trace.steps[0]] };
	const timed = renderToStaticMarkup(createElement(WorkTimeline, { blocks: empty, activity: measured }));
	assert.match(timed, /Thought 2s/);
	assert.doesNotMatch(timed, /details|summary|svg/);
	const live = renderToStaticMarkup(createElement(WorkTimeline, { blocks: empty, running: true }));
	assert.match(live, /Thinking/);
	assert.match(live, /class="work-shimmer"[^>]*>Thinking<\/span>/);
	assert.doesNotMatch(live, /details|summary|svg/);
});

test("codemode lists nested calls in order without exposing its input or output", () => {
	const batch: PiBlock = { kind: "tool", ...tool("batch", "codemode", { code: "hidden wrapper code" }), result: "hidden wrapper output", children: [
		tool("read", "read", { path: "first.ts" }),
		{ ...tool("nested", "functions.codemode", { code: "hidden nested code" }), result: "hidden nested output", children: [
			tool("search", "symbol_search", { query: "second" }),
		] },
		tool("bash", "bash", { command: "pnpm test" }),
	] };
	const html = renderToStaticMarkup(createElement(WorkTimeline, { blocks: [batch], expanded: true }));
	assert.match(html, /codemode tool list/);
	assert.match(html, /class="pl-4 \[&amp;&gt;\*\]:my-0"/);
	assert.ok(html.indexOf(">codemode<") < html.indexOf("Read first.ts"));
	assert.ok(html.indexOf("Read first.ts") < html.indexOf("Searched second"));
	assert.ok(html.indexOf("Searched second") < html.indexOf("Ran pnpm test"));
	assert.doesNotMatch(html, /hidden wrapper|hidden nested/);
});

test("codemode without recorded children does not expose wrapper payloads", () => {
	const html = renderToStaticMarkup(createElement(WorkTimeline, { blocks: [
		{ kind: "tool", ...tool("batch", "codemode", { code: "hidden code" }), result: "hidden output" },
	] }));
	assert.match(html, />codemode</);
	assert.doesNotMatch(html, /hidden code|hidden output|raw tool input|raw tool output/);
});
