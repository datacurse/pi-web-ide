import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RawBlocks } from "./RawOutput.js";

test("raw output preserves markdown, whitespace and tool result anchors", () => {
	const html = renderToStaticMarkup(RawBlocks({ blocks: [
		{ kind: "text", text: "**literal**\n  indented" },
		{ kind: "thinking", text: "reasoning" },
		{ kind: "tool", id: "tool", name: "read", args: { path: "file.ts" }, result: "ABCD│const x = 1;" },
	] }));
	assert.ok(html.includes("**literal**\n  indented"));
	assert.ok(html.includes("ABCD│const x = 1;"));
	assert.ok(html.includes("reasoning"));
	assert.ok(!html.includes("<strong>"));
	assert.ok(!html.includes("<details"));
});
