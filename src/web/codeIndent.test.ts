import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBox } from "./Markdown.js";
import { AnchorDiff } from "./AnchorDiff.js";
import { dedentBlocks } from "./codeIndent.js";

test("common indentation is stripped while nested indentation stays", () => {
	assert.deepEqual(dedentBlocks([["    if (ok) {", "      call();", "        nested();", "    }"]]),
		[["if (ok) {", "  call();", "    nested();", "}"]]);
});

test("blank lines don't constrain indentation and source arrays remain unchanged", () => {
	const lines = ["", "      first();", "  ", "        second();"];
	assert.deepEqual(dedentBlocks([lines]), [["", "first();", "", "  second();"]]);
	assert.equal(lines[1], "      first();");
	assert.deepEqual(dedentBlocks([["", "   "]]), [["", "   "]]);
});

test("diff sides share one baseline so indentation edits remain visible", () => {
	assert.deepEqual(dedentBlocks([["    old();"], ["      new();"]]), [["old();"], ["  new();"]]);
	assert.deepEqual(dedentBlocks([[], ["        added();"]]), [[], ["added();"]]);
});

test("tabs are stripped conservatively and flush-left code is unchanged", () => {
	assert.deepEqual(dedentBlocks([["\tfirst();", "\t\tnested();"]]), [["first();", "\tnested();"]]);
	assert.deepEqual(dedentBlocks([["\tfirst();", "    second();"]]), [["\tfirst();", "    second();"]]);
	assert.deepEqual(dedentBlocks([["first();", "    nested();"]]), [["first();", "    nested();"]]);
});

test("code boxes and replacement diffs render without their shared leading indent", () => {
	const code = renderToStaticMarkup(createElement(CodeBox, { text: "    first();\n      second();", className: "" }));
	assert.ok(code.includes("first();"));
	assert.ok(!code.includes("    first();"));
	assert.ok(code.includes("  second();"));
	const diff = renderToStaticMarkup(createElement(AnchorDiff, { diff: { from: "AAAA", to: "AAAA", removed: ["    old();"], added: ["      new();"] } }));
	assert.ok(!diff.includes("    old();"));
	assert.ok(diff.includes("  new();"));
});
