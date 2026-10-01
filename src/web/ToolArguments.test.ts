import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolArguments } from "./ToolArguments.js";
import { Tool } from "./Transcript.js";

const render = (name: string, args: unknown) => renderToStaticMarkup(createElement(ToolArguments, { name, args }));

test("reads show file and metadata without a JSON argument dump", () => {
	const html = render("read", { path: "src/app.ts", offset: 12, limit: 24 });
	assert.match(html, /src\/app.ts/);
	assert.match(html, /<dt[^>]*>offset<\/dt>/);
	assert.match(html, />12<\/pre>/);
	assert.doesNotMatch(html, /&quot;path&quot;/);
});

test("shell commands remain escaped and preserve extra options", () => {
	const html = render("bash", { command: "echo <script>alert(1)</script>\nls", timeout: 10 });
	assert.match(html, /Command/);
	assert.match(html, /echo &lt;script&gt;/);
	assert.match(html, /timeout/);
	assert.doesNotMatch(html, /<script>/);
});

test("each edit has a unified diff and execution options stay visible", () => {
	const html = render("edit", { path: "app.ts", edits: [
		{ oldText: "old", newText: "new" }, { oldText: "", newText: "added" },
	], then_run: { command: "pnpm test" } });
	assert.equal((html.match(/cm-review/g) ?? []).length, 2);
	assert.match(html, /pnpm test/);
	assert.doesNotMatch(html, /oldText/);
});

test("writes render content and unknown or malformed arguments remain readable", () => {
	assert.match(render("write", { path: "a.ts", content: "<hello>\nworld" }), /&lt;hello&gt;\nworld/);
	assert.match(render("custom", { pattern: "needle", config: { nested: true } }), /needle/);
	assert.match(render("edit", { edits: [{ oldText: 1 }] }), /oldText/);
	assert.match(render("read", "partial"), /partial/);
	assert.match(render("custom", ["a", "b"]), /&quot;a&quot;/);
	assert.equal(render("read", undefined), "");
});

test("structured arguments retain unavailable-output and error results", () => {
	const html = renderToStaticMarkup(createElement(Tool, {
		name: "bash", args: { command: "false" }, autoOpen: false,
		expandedByDefault: true, result: "failed command", isError: true, outputUnavailable: true,
	}));
	assert.match(html, /Nested output was not retained/);
	assert.match(html, /failed command/);
	assert.match(html, /aria-expanded="true"/);
});
