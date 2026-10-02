import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { Virtuoso } from "react-virtuoso";
import ts from "typescript";
import type { Chat } from "./Chat.js";
import { AskPanel } from "./AskPanel.js";
import * as transcript from "./Transcript.js";
import type { Snapshot } from "../shared/types.js";

import { RawBlocks } from "./RawOutput.js";
import { TodoList } from "./TodoList.js";

const require = createRequire(import.meta.url);
const modules: Record<string, unknown> = {
	"react/jsx-runtime": require("react/jsx-runtime"),
	"react-virtuoso": { Virtuoso },
	"@phosphor-icons/react": require("@phosphor-icons/react"),
	"./ui.js": require("./ui.js"),
	"../shared/toolTree.js": require("../shared/toolTree.js"),
	"./ModelSelector.js": require("./ModelSelector.js"),
	"./GitActions.js": require("./GitActions.js"),
	"./Markdown.js": require("./Markdown.js"),
	"./RawOutput.js": { RawBlocks },
	"./rawTurns.js": require("./rawTurns.js"),
	"./prefs.js": require("./prefs.js"),
	"./drafts.js": require("./drafts.js"),
	"./commands.js": require("./commands.js"),
	"./AskPanel.js": { AskPanel },
	"./OverlayScrollbar.js": require("./OverlayScrollbar.js"),
	"./Attachments.js": require("./Attachments.js"),
	"./Transcript.js": transcript,
	"./i18n.js": require("./i18n.js"),
	"./piMark.js": require("./piMark.js"),
	"./PastedTexts.js": require("./PastedTexts.js"),
	"./pastedText.js": require("./pastedText.js"),
	"./TodoList.js": { TodoList },
};
const source = ts.transpileModule(readFileSync(new URL("./Chat.tsx", import.meta.url), "utf8"), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
type Node = React.ReactElement<Record<string, any>>;

function descendants(node: unknown): Node[] {
	if (Array.isArray(node)) return node.flatMap(descendants);
	if (!React.isValidElement(node)) return [];
	const element = node as Node;
	return [element, ...descendants(element.props.children)];
}

function harness() {
	const slots: unknown[] = [];
	let cursor = 0;
	let effects: (() => unknown)[] = [];
	const observers: { callback: () => void; target?: unknown; disconnected: boolean }[] = [];
	const exports = {} as { Chat: typeof Chat };
	runInNewContext(source, {
		exports,
		ResizeObserver: class {
			entry: typeof observers[number];
			constructor(callback: () => void) {
				this.entry = { callback, disconnected: false };
				observers.push(this.entry);
			}
			observe(target: unknown) { this.entry.target = target; }
			disconnect() { this.entry.disconnected = true; }
		},
		require(name: string) {
			if (name !== "react") {
				if (Object.hasOwn(modules, name)) return modules[name];
				throw new Error(`Unexpected import: ${name}`);
			}
			return {
				...React,
				useState(initial: unknown) {
					const at = cursor++;
					if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
					return [slots[at], (value: unknown) => {
						slots[at] = typeof value === "function" ? value(slots[at]) : value;
					}];
				},
				useRef(initial: unknown) {
					const at = cursor++;
					if (!(at in slots)) slots[at] = { current: initial };
					return slots[at];
				},
				useMemo: (calculate: () => unknown) => calculate(),
				useCallback: (callback: unknown) => callback,
				useEffect: (effect: () => unknown) => { effects.push(effect); },
			};
		},
	});
	const snapshot: Snapshot = {
		id: "session", file: undefined, cwd: "/project", model: undefined,
		messages: Array.from({ length: 1000 }, (_, i) => ({
			role: i % 2 ? "assistant" : "user",
			timestamp: i + 1, blocks: [{ kind: "text", text: `message ${i}` }],
		})),
		partial: null, isStreaming: false, error: null, notices: [], ask: null,
		hunks: [], commands: [], supportsImages: false, thinkingLevel: undefined,
		thinkingLevels: [], contextTokens: 0, contextWindow: 0, stale: false,
	};
	const props: Parameters<typeof Chat>[0] = {
		snapshot, partial: { text: "", thinking: "", tools: [] }, busy: false, opening: false,
		userMode: "full", askMode: "once",
		onAskMode() {}, onAnswerAsk() {}, onSend() {}, onAbort() {}, onModelChange() {},
		onThinkingChange() {}, onFastChange: async () => {}, onCommandMenu() {},
		onCompact() {}, compacting: false, onFork: async () => {}, onEdit() {}, onRestart() {},
	};
	const viewport = { scrollTop: 0, scrollHeight: 10000, clientHeight: 600 };
	function render() {
		cursor = 0;
		effects = [];
		return descendants(exports.Chat(props));
	}
	const first = render();
	const pane = first.find((node) => node.props.onScroll)!;
	pane.props.ref(viewport);
	const nodes = render();
	const body = nodes.find((node) => node.type === "div" && node.props.ref && typeof node.props.ref === "object")!;
	body.props.ref.current = {};
	const resizeEffect = effects.find((effect) => effect.toString().includes("new ResizeObserver"))!;
	const cleanup = resizeEffect() as () => void;
	return { props, viewport, nodes, render, observers, cleanup };
}

test("history is passed to Virtuoso without eagerly mounting message rows", () => {
	const env = harness();
	const list = env.nodes.find((node) => node.type === Virtuoso)!;
	assert.equal(list.props.data.length, 1000);
	assert.equal(list.props.initialTopMostItemIndex, 999);
	assert.equal(list.props.customScrollParent, env.viewport);
		assert.ok(list.props.increaseViewportBy > 0);
	assert.equal(env.nodes.filter((node) => node.props.row).length, 0);
	const selected = list.props.itemContent(250, list.props.data[250]) as Node;
	assert.equal(selected.props.row.blocks[0].text, "message 250");
	assert.equal(selected.props.expanded, false);
	assert.equal((selected.type as any).$$typeof, Symbol.for("react.memo"));
	const key = list.props.computeItemKey(250, list.props.data[250]);
	env.props.partial.text = "streaming update";
	const updated = env.render().find((node) => node.type === Virtuoso)!;
	assert.equal(updated.props.computeItemKey(250, updated.props.data[250]), key);
});

test("user prompts keep attachments and inline editing through UserMessage", () => {
	const env = harness();
	env.props.userMode = "expanded";
	const list = env.render().find((node) => node.type === Virtuoso)!;
	const selected = list.props.itemContent(0, list.props.data[0]) as Node;
	const rendered = (selected.type as any).type(selected.props) as Node;
	assert.equal(rendered.type, transcript.UserMessage);
	assert.equal(rendered.props.blocks, list.props.data[0].blocks);
	assert.equal(rendered.props.at, 1);
	assert.equal(rendered.props.userMode, "expanded");
	assert.equal(rendered.props.onEdit, env.props.onEdit);
	env.props.busy = true;
	const busyList = env.render().find((node) => node.type === Virtuoso)!;
	const busyRow = busyList.props.itemContent(0, busyList.props.data[0]) as Node;
	assert.equal((busyRow.type as any).type(busyRow.props).props.onEdit, undefined);
});

test("history keeps reasoning in work and the final answer outside", () => {
	const env = harness();
	env.props.snapshot!.messages = [
		{ role: "user", timestamp: 1, blocks: [{ kind: "text", text: "question" }] },
		{ role: "assistant", timestamp: 2, blocks: [{ kind: "thinking", text: "reasoning" }, { kind: "text", text: "**answer**" }] },
	];
	const list = env.render().find((node) => node.type === Virtuoso)!;
	assert.equal(list.props.data.length, 2);
	assert.equal(list.props.data[0].role, "user");
	assert.equal(list.props.data[1].work[0].text, "reasoning");
	assert.equal(list.props.data[1].blocks[0].text, "**answer**");
});
test("content growth follows only while pinned, and jump-to-latest resumes following", () => {
	const env = harness();
	const observer = env.observers[0];
	env.viewport.scrollHeight = 12000;
	observer.callback();
	assert.equal(env.viewport.scrollTop, 12000);
	env.viewport.scrollTop = 1000;
	env.nodes.find((node) => node.props.onScroll)!.props.onScroll({ currentTarget: env.viewport });
	env.viewport.scrollHeight = 14000;
	observer.callback();
	assert.equal(env.viewport.scrollTop, 1000);
	const jump = env.render().find((node) => node.props.label === "Jump to the latest message")!;
	jump.props.onClick();
	assert.equal(env.viewport.scrollTop, 14000);
	env.viewport.scrollHeight = 16000;
	observer.callback();
	assert.equal(env.viewport.scrollTop, 16000);
	env.cleanup();
	assert.equal(observer.disconnected, true);
});

test("one collapsed toggle hides live work and toggles all intermediate output", () => {
	const env = harness();
	env.props.busy = true;
	env.props.partial.text = "live answer";
	env.props.partial.thinking = "reasoning";
	env.props.snapshot!.ask = { id: "ask", kind: "text", message: "question" };
	const nodes = env.render();
	assert.ok(nodes.some((node) => node.type === AskPanel));
	const list = nodes.find((node) => node.type === Virtuoso)!;
	const i = list.props.data.length - 1;
	const selected = list.props.itemContent(i, list.props.data[i]) as Node;
	assert.equal(selected.props.expanded, false);
	const rendered = (selected.type as any).type(selected.props);
	assert.equal(descendants(rendered).filter((node) => node.type === RawBlocks && node.props.blocks.length > 0).length, 0);
	selected.props.onToggle();
	const updated = env.render().find((node) => node.type === Virtuoso)!;
	const opened = updated.props.itemContent(i, updated.props.data[i]) as Node;
	assert.equal(opened.props.expanded, true);
	assert.ok(descendants((opened.type as any).type(opened.props)).some((node) => node.type === RawBlocks && node.props.blocks.some((block: any) => block.text === "live answer")));
});

test("raw live tools stay visible without folding or duplicating settled calls", () => {
	const env = harness();
	env.props.busy = true;
	env.props.snapshot!.messages = [
		{ role: "assistant", timestamp: 2, blocks: [{ kind: "tool", id: "a", name: "read", args: {} }] },
	];
	env.props.partial.tools = [{ id: "a", name: "read", args: {}, result: "raw output" }, { id: "b", name: "bash", args: {}, running: true }];
	const nodes = env.render();
	const list = nodes.find((node) => node.type === Virtuoso)!;
	assert.equal(list.props.data[0].work[0].result, "raw output");
	assert.deepEqual(Array.from(list.props.data[0].work, (block: any) => block.id), ["a", "b"]);
});

test("live todos render directly under Show work, not beside the composer", () => {
	const env = harness();
	env.props.busy = true;
	env.props.partial.tools = [{ id: "todo", name: "todo", args: {}, todos: [{ id: 1, subject: "Move checklist", status: "in_progress" }] }];
	const nodes = env.render();
	assert.equal(nodes.some((node) => node.type === TodoList), false);
	const list = nodes.find((node) => node.type === Virtuoso)!;
	const i = list.props.data.length - 1;
	const selected = list.props.itemContent(i, list.props.data[i]) as Node;
	assert.equal(selected.props.expanded, false);
	const rowNodes = descendants((selected.type as any).type(selected.props));
	const toggle = rowNodes.findIndex((node) => node.props.children === "Show work");
	const checklist = rowNodes.findIndex((node) => node.type === TodoList);
	assert.ok(toggle >= 0 && checklist > toggle);
	assert.equal(rowNodes[checklist].props.tasks[0].subject, "Move checklist");
	selected.props.onToggle();
	const updated = env.render().find((node) => node.type === Virtuoso)!;
	const opened = updated.props.itemContent(i, updated.props.data[i]) as Node;
	assert.equal(opened.props.expanded, true);
	const expandedNodes = descendants((opened.type as any).type(opened.props));
	const work = expandedNodes.findIndex((node) => node.type === RawBlocks && node.props.blocks === opened.props.row.work);
	const expandedChecklist = expandedNodes.findIndex((node) => node.type === TodoList);
	assert.ok(work >= 0 && expandedChecklist > work);
});

test("settled answer actions use the assistant timestamp and are absent while streaming", () => {
	const env = harness();
	env.props.snapshot!.messages = [
		{ role: "user", timestamp: 1, blocks: [{ kind: "text", text: "question" }] },
		{ role: "assistant", timestamp: 2, blocks: [{ kind: "thinking", text: "reasoning" }, { kind: "text", text: "answer" }] },
	];
	const rowNodes = () => {
		const list = env.render().find((node) => node.type === Virtuoso)!;
		const row = list.props.itemContent(1, list.props.data[1]) as Node;
		return descendants((row.type as any).type(row.props));
	};
	const actions = rowNodes().find((node) => node.type === transcript.AnswerActions)!;
	assert.equal(actions.props.at, 2);
	assert.equal(actions.props.text, "answer");
	assert.equal(actions.props.onFork, env.props.onFork);
	env.props.busy = true;
	assert.equal(rowNodes().some((node) => node.type === transcript.AnswerActions), false);
});
