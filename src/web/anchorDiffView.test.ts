import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnchorDiff } from "./AnchorDiff.js";

test("unknown paths use TypeScript highlighting and snippet numbers replace diff markers", () => {
	const html = renderToStaticMarkup(createElement(AnchorDiff, { diff: {
		from: "AAAA", to: "AAAA", removed: ["    assert.equal(active, true);"],
		added: ["    assert.equal(active, false);", "    assert.ok(done);"],
	} }));
	assert.equal((html.match(/data-language="typescript"/g) ?? []).length, 2);
	assert.ok(html.includes('aria-label="Removed snippet line 1"'));
	assert.ok(html.includes('aria-label="Replacement snippet line 1"'));
	assert.ok(html.includes('aria-label="Replacement snippet line 2"'));
	assert.ok(!html.includes(">−<"));
	assert.ok(!html.includes(">+<"));
	assert.ok(html.includes("bg-red-400/10"));
	assert.ok(html.includes("bg-green-400/10"));
	assert.ok(html.includes("flex items-baseline px-2"));
	assert.ok(html.includes("mr-2 w-4 shrink-0 select-none text-center"));
	assert.ok(!/snippet line[^>]+class="[^"]*text-meta/.test(html));
});

test("known filenames keep their own language and wrapped source gets only one number", () => {
	const html = renderToStaticMarkup(createElement(AnchorDiff, { diff: {
		from: "AAAA", to: "AAAA", path: "src/example.py",
		removed: ["print('old')"], added: ["print('a very long line that may wrap visually but is still one source line')"],
	} }));
	assert.equal((html.match(/data-language="example.py"/g) ?? []).length, 2);
	assert.ok(!html.includes("snippet line 2"));
});

test("both diff sides share a wider centered gutter for multi-digit numbers", () => {
	const html = renderToStaticMarkup(createElement(AnchorDiff, { diff: {
		from: "AAAA", to: "AAAA", removed: ["old();"], added: Array.from({ length: 10 }, () => "new();"),
	} }));
	assert.equal((html.match(/mr-2 w-6 /g) ?? []).length, 11);
	assert.ok(html.includes('aria-label="Replacement snippet line 10"'));
});

test("captured file locations use actual file numbers, including the replacement side", () => {
	const html = renderToStaticMarkup(createElement(AnchorDiff, { diff: {
		from: "AAAA", to: "AAAA", path: "/project/src/app.ts", line: 242,
		removed: ["old();"], added: ["new();", "next();"],
	} }));
	assert.ok(html.includes("/project/src/app.ts"));
	assert.ok(html.includes("L242 at edit"));
	assert.ok(html.includes('aria-label="Removed file line 242"'));
	assert.ok(html.includes('aria-label="Replacement file line 243"'));
	assert.ok(html.includes("mr-2 w-8"));
});

test("recovered current locations never pretend to be original file line numbers", () => {
	const html = renderToStaticMarkup(createElement(AnchorDiff, { diff: {
		from: "AAAA", to: "AAAA", path: "/project/src/app.py", currentLine: 88,
		removed: ["old()"], added: ["new()"],
	} }));
	assert.ok(html.includes("current L88 (original line unavailable)"));
	assert.ok(html.includes('aria-label="Removed snippet line 1"'));
	assert.ok(!html.includes("file line 88"));
});
