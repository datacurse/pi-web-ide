import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { AnchorDiff } from "./AnchorDiff.js";
import { fileLocation, FileNavigationContext, revealFileLine } from "./fileNavigation.js";

test("source headers are keyboard-accessible file navigation buttons at the resolved line", () => {
	const html = renderToStaticMarkup(createElement(FileNavigationContext.Provider, { value: () => {} },
		createElement(AnchorDiff, { diff: { from: "AAAA", to: "AAAA", path: "/project/app.ts", currentLine: 111, removed: ["old();"], added: ["new();"] } })));
	assert.ok(html.includes('<button type="button" data-custom="replacement file navigation"'));
	assert.ok(html.includes('title="Open /project/app.ts at line 111"'));
	assert.ok(html.includes("L111 (current)"));
});

test("unknown files remain non-interactive, and known files can open without invented line numbers", () => {
	const render = (path?: string) => renderToStaticMarkup(createElement(FileNavigationContext.Provider, { value: () => {} },
		createElement(AnchorDiff, { diff: { from: "AAAA", to: "AAAA", path, added: ["new();"] } })));
	assert.ok(!render().includes("replacement file navigation"));
	assert.ok(render("/project/app.ts").includes('title="Open /project/app.ts"'));
});

test("navigation targets today's location if both historical and current lines are known", () => {
	const html = renderToStaticMarkup(createElement(FileNavigationContext.Provider, { value: () => {} },
		createElement(AnchorDiff, { diff: { from: "AAAA", to: "AAAA", path: "/project/app.ts", line: 42, currentLine: 118, added: ["new();"] } })));
	assert.ok(html.includes('title="Open /project/app.ts at line 118"'));
});

test("repeated source clicks create fresh reveal requests while absent/invalid lines don't", () => {
	const first = fileLocation(undefined, "/project/app.ts", 111);
	assert.deepEqual(first, { path: "/project/app.ts", line: 111, request: 1 });
	assert.deepEqual(fileLocation(first, "/project/app.ts", 111), { path: "/project/app.ts", line: 111, request: 2 });
	assert.equal(fileLocation(first, "/project/app.ts"), undefined);
	assert.equal(fileLocation(first, "/project/app.ts", NaN), undefined);
	assert.equal(fileLocation(first, "/project/app.ts", 0), undefined);
});

test("revealing a line centers and focuses it without changing the editor's document", () => {
	let state = EditorState.create({ doc: "first\nsecond\nthird" });
	let focused = 0;
	let effects: readonly unknown[] = [];
	const view = {
		get state() { return state; },
		dispatch(spec: Parameters<EditorState["update"]>[0]) {
			const transaction = state.update(spec);
			state = transaction.state;
			effects = transaction.effects;
		},
		focus() { focused++; },
	} as unknown as EditorView;
	revealFileLine(view, { EditorView }, 2);
	assert.equal(state.selection.main.from, 6);
	assert.equal(state.doc.toString(), "first\nsecond\nthird");
	assert.equal(focused, 1);
	assert.equal(effects.length, 1);
	assert.equal((effects[0] as { value: { y: string } }).value.y, "center");

	revealFileLine(view, { EditorView }, 999);
	assert.equal(state.selection.main.from, 13, "a moved or shortened file clamps to its last line");
	revealFileLine(view, { EditorView }, 0);
	assert.equal(state.selection.main.from, 0);
	assert.equal(focused, 3);
});
