import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { ResponseTime, responseTimeDetails } from "./ResponseTime.js";
import { timeAgo } from "./SessionList.js";

test("response age uses completion time and exposes exact date plus measured work", (t) => {
	const at = new Date(2026, 9, 2, 6, 20).getTime();
	t.mock.method(Date, "now", () => at + 180_000);
	const html = renderToStaticMarkup(React.createElement(ResponseTime, { at, durationMs: 10_900 }));
	assert.match(html, />3m ago<\/time>/);
	assert.match(html, /Worked for 10s/);
	assert.match(html, /2026/);
	assert.match(html, /tabindex="0"/);
	assert.doesNotMatch(html, /title=|role="tooltip"/, "no native tooltip or popup before hover");
	assert.equal(responseTimeDetails(at).worked, undefined);
	assert.equal(responseTimeDetails(at, -10).worked, "Worked for 0s");
});

test("work durations show minutes and remaining seconds", () => {
	const at = 1000;
	for (const [ms, expected] of [
		[59_999, "59s"],
		[60_000, "1m 0s"],
		[197_900, "3m 17s"],
		[3_661_000, "61m 1s"],
	] as const) {
		assert.equal(responseTimeDetails(at, ms).worked, `Worked for ${expected}`);
	}
});

type Node = React.ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
	if (Array.isArray(value)) return value.flatMap(nodes);
	if (!React.isValidElement(value)) return [];
	const node = value as Node;
	return [node, ...nodes(node.props.children)];
}

function harness() {
	const require = createRequire(import.meta.url);
	const source = ts.transpileModule(readFileSync(new URL("./ResponseTime.tsx", import.meta.url), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
	}).outputText;
	const slots: any[] = [];
	let cursor = 0;
	let effects: (() => unknown)[] = [];
	let layouts: (() => unknown)[] = [];
	const timers = new Map<number, () => void>();
	let timerId = 0;
	const listeners = new Map<string, () => void>();
	const exports = {} as { ResponseTime: typeof ResponseTime };
	runInNewContext(source, {
		exports, document: { body: {} },
		window: {
			innerWidth: 300, innerHeight: 200,
			addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
			removeEventListener: (name: string) => listeners.delete(name),
		},
		setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
		clearTimeout: (id: number) => timers.delete(id),
		setInterval: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
		clearInterval: (id: number) => timers.delete(id),
		require(name: string) {
			if (name === "react/jsx-runtime") return require("react/jsx-runtime");
			if (name === "react-dom") return { createPortal: (node: unknown) => node };
			if (name === "./i18n.js") return require("./i18n.js");
			if (name === "./SessionList.js") return { timeAgo };
			if (name !== "react") throw new Error(name);
			return {
				useId: () => "response-time",
				useRef(initial: unknown) {
					const at = cursor++;
					return slots[at] ??= { current: initial };
				},
				useState(initial: unknown) {
					const at = cursor++;
					if (!(at in slots)) slots[at] = initial;
					return [slots[at], (next: any) => { slots[at] = typeof next === "function" ? next(slots[at]) : next; }];
				},
				useEffect: (effect: () => unknown) => effects.push(effect),
				useLayoutEffect: (effect: () => unknown) => layouts.push(effect),
			};
		},
	});
	const render = () => {
		cursor = 0; effects = []; layouts = [];
		const result = nodes(exports.ResponseTime({ at: 1000, durationMs: 10_000 }));
		result.find((node) => node.type === "span")!.props.ref.current = {
			getBoundingClientRect: () => ({ left: 260, top: 10, bottom: 30 }),
		};
		const tooltip = result.find((node) => node.props.role === "tooltip");
		if (tooltip) tooltip.props.ref.current = { getBoundingClientRect: () => ({ width: 170, height: 60 }) };
		return result;
	};
	return { render, layouts: () => layouts, effects: () => effects, timers, listeners };
}

test("hover and focus show a viewport-clamped portal; escape and scroll dismiss it", () => {
	const env = harness();
	let anchor = env.render().find((node) => node.type === "span")!;
	anchor.props.onMouseEnter();
	let rendered = env.render();
	assert.equal(rendered.find((node) => node.props.role === "tooltip")!.props.id, "response-time");
	env.layouts().forEach((effect) => effect());
	rendered = env.render();
	const card = rendered.find((node) => node.props.role === "tooltip")!;
	assert.equal(card.props.style.left, 122, "clamped away from right edge");
	assert.equal(card.props.style.top, 38, "placed below when no room above");
	anchor = rendered.find((node) => node.type === "span")!;
	assert.equal(anchor.props["aria-describedby"], "response-time");
	anchor.props.onMouseLeave();
	assert.equal(env.timers.size, 1);
	card.props.onMouseEnter();
	assert.equal(env.timers.size, 0, "hover card remains reachable");
	anchor.props.onKeyDown({ key: "Escape" });
	assert.equal(env.render().some((node) => node.props.role === "tooltip"), false);
	anchor.props.onFocus();
	env.render();
	env.effects()[1]();
	env.listeners.get("scroll")!();
	assert.equal(env.render().some((node) => node.props.role === "tooltip"), false);
	anchor.props.onBlur();
});

test("age refresh timer is cleaned up when the footer unmounts", (t) => {
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const env = harness();
	assert.equal(env.render().find((node) => node.type === "time")!.props.children, "just now");
	const cleanup = env.effects()[0]() as () => void;
	assert.equal(env.timers.size, 1);
	now = 121000;
	[...env.timers.values()][0]();
	assert.equal(env.render().find((node) => node.type === "time")!.props.children, "2m ago");
	cleanup();
	assert.equal(env.timers.size, 0);
});
