import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RawBlocks } from "./RawOutput.js";

test("model responses and reasoning render Markdown", () => {
	const html = renderToStaticMarkup(RawBlocks({ blocks: [
		{ kind: "text", text: "# Answer\n\n**bold** and `inline`\n\n- first\n- second\n\n[link](https://example.com)\n\n```ts\nconst x = 1;\n```" },
		{ kind: "thinking", text: "**Analyzing** imports" },
	] }));
	assert.match(html, /<h1[^>]*>Answer<\/h1>/);
	assert.match(html, /<strong>bold<\/strong>/);
	assert.match(html, /<code[^>]*>inline<\/code>/);
	assert.match(html, /<ul/);
	assert.match(html, /<li>first<\/li>/);
	assert.match(html, /href="https:\/\/example.com"/);
	assert.match(html, /const x = 1;/);
	assert.match(html, /<strong>Analyzing<\/strong>/);
});

test("tool inputs, outputs and nested calls stay literal and collapsed", () => {
	const html = renderToStaticMarkup(RawBlocks({ blocks: [
		{ kind: "tool", id: "tool", name: "read", args: { text: "**input**" }, result: "# Heading\n**literal**\n  indented\nABCD│const x = 1;\n<script>alert(1)</script>", children: [
			{ id: "child", name: "bash", args: { command: "**nested input**" }, result: "**nested output**" },
		] },
	] }));
	assert.ok(html.includes("**input**"));
	assert.ok(html.includes("# Heading\n**literal**\n  indented"));
	assert.ok(html.includes("ABCD│const x = 1;"));
	assert.ok(html.includes("**nested input**"));
	assert.ok(html.includes("**nested output**"));
	assert.ok(html.includes("&lt;script&gt;"));
	assert.ok(!html.includes("<strong>"));
	assert.equal((html.match(/<details/g) ?? []).length, 2);
	assert.ok(!html.includes("<details open"));
	assert.ok(html.includes("<summary"));
});

test("streaming model prose renders Markdown", () => {
	const html = renderToStaticMarkup(RawBlocks({ streaming: true, blocks: [{ kind: "text", text: "**Live** answer" }] }));
	assert.match(html, /<strong>Live<\/strong>/);
});
