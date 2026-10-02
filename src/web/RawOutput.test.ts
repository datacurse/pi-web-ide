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

test("anchor replacements show a removed range and literal green source lines", () => {
	const html = renderToStaticMarkup(RawBlocks({ blocks: [{
		kind: "tool", id: "replace", name: "functions.replace", args: {
			remove_from: "agfl", remove_to: "xyzw",
			replacement_lines: ["\tassert.match(exploring, /<span>Explored/);", "", "\t**literal**"],
		},
	}] }));
	assert.ok(html.includes("Remove lines agfl → xyzw (inclusive)"));
	assert.ok(html.includes("bg-red-400/10"));
	assert.ok(html.includes("bg-green-400/10"));
	assert.ok(html.includes("assert.match(exploring, /&lt;span&gt;Explored/);"));
	assert.ok(!html.includes("\tassert.match"));
	assert.ok(html.includes("**literal**"));
	assert.ok(!html.includes("replacement_lines"));
	assert.ok(!html.includes("<strong>"));
});

test("single-line replacements and deletions describe the range without inventing old source", () => {
	const html = renderToStaticMarkup(RawBlocks({ blocks: [{
		kind: "tool", id: "delete", name: "replace",
		args: { remove_from: "CUWB", remove_to: "CUWB", replacement_lines: [] },
	}] }));
	assert.ok(html.includes("Remove line CUWB"));
	assert.ok(html.includes("Deletion only"));
	assert.ok(!html.includes("Replacement lines"));
});

test("incomplete or malformed replacement arguments retain the JSON fallback", () => {
	for (const args of [null, { remove_from: "CUWB" }, { remove_from: "a", remove_to: "b", replacement_lines: [42] }]) {
		const html = renderToStaticMarkup(RawBlocks({ blocks: [{ kind: "tool", id: "bad", name: "replace", args }] }));
		assert.ok(html.includes('data-custom="raw tool input"'));
		assert.ok(!html.includes('data-custom="anchor replacement diff"'));
	}
});

test("replacement diffs show recorded removed source instead of its anchor label", () => {
	const html = renderToStaticMarkup(RawBlocks({ blocks: [{
		kind: "tool", id: "actual", name: "replace",
		args: { remove_from: "RNMT", remove_to: "last", replacement_lines: ["\tassert.equal(last.active, false);"] },
		result: " ...\n-RNMT│\tassert.equal(last.active, true);\n-last│<script>old</script>\n+NEW1│\tassert.equal(last.active, false);\n unchanged context",
	}] }));
	const diff = html.split('data-custom="anchor replacement diff"')[1].split('data-custom="raw tool output"')[0];
	assert.ok(diff.includes("\tassert.equal(last.active, true);"));
	assert.ok(diff.includes("&lt;script&gt;old&lt;/script&gt;"));
	assert.ok(!diff.includes("RNMT"));
	assert.ok(!diff.includes("unchanged context"));
	assert.ok(diff.includes('aria-label="Removed lines"'));
});

test("saved codemode results supply the exact old range for their nested replacements", () => {
	const html = renderToStaticMarkup(RawBlocks({ blocks: [{
		kind: "tool", id: "batch", name: "codemode", args: {},
		result: "-AAAA│first old line\n+BBBB│first new line\n-RNMT│second old line\n+CCCC│second new line",
		children: [{ id: "child", name: "replace", args: { remove_from: "RNMT", remove_to: "RNMT", replacement_lines: ["second new line"] }, outputUnavailable: true }],
	}] }));
	const diff = html.split('data-custom="anchor replacement diff"')[1];
	assert.ok(diff.includes("second old line"));
	assert.ok(!diff.includes("first old line"));
	assert.ok(!diff.includes("Remove line RNMT"));
});
