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
});

test("known filenames keep their own language and wrapped source gets only one number", () => {
	const html = renderToStaticMarkup(createElement(AnchorDiff, { diff: {
		from: "AAAA", to: "AAAA", path: "src/example.py",
		removed: ["print('old')"], added: ["print('a very long line that may wrap visually but is still one source line')"],
	} }));
	assert.equal((html.match(/data-language="example.py"/g) ?? []).length, 2);
	assert.ok(!html.includes("snippet line 2"));
});
