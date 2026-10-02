import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PiMessage, PiTool } from "../shared/types.js";
import { reducePartial, emptyPartial } from "../shared/partial.js";
import { ToolSourceTracker } from "./toolSources.js";

function harness(t: TestContext) {
	const cwd = mkdtempSync(join(tmpdir(), "pwi-tool-source-"));
	const previous = process.env.PWI_STATE_DIR;
	process.env.PWI_STATE_DIR = cwd;
	t.after(() => {
		if (previous === undefined) delete process.env.PWI_STATE_DIR;
		else process.env.PWI_STATE_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, tracker: new ToolSourceTracker("session", cwd) };
}
function start(tracker: ToolSourceTracker, id: string, name: string, args: unknown) {
	tracker.record({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
}
function end(tracker: ToolSourceTracker, id: string, text: string, isError = false) {
	tracker.record({ type: "tool_execution_end", toolCallId: id, isError, result: { content: [{ type: "text", text }] } });
}
function history(tools: PiTool[]): PiMessage[] {
	return [{ role: "assistant", timestamp: 1, blocks: [{ kind: "tool", id: "batch", name: "codemode", args: {}, children: tools }] }];
}
function source(tracker: ToolSourceTracker, id: string) {
	const event = tracker.event({ type: "tool_start", id, name: "replace", args: {} });
	assert.equal(event.type, "tool_start");
	return event.type === "tool_start" ? event.source : undefined;
}

test("captures exact file lines before editing and retains them across restarts and nested snapshots", (t) => {
	const { cwd, tracker } = harness(t);
	const path = join(cwd, "app.ts");
	writeFileSync(path, "first();\n    old();\nlast();\n");
	start(tracker, "read", "read", { path: "app.ts" });
	end(tracker, "read", "AAAA│first();\nBBBB│    old();\nCCCC│last();");
	start(tracker, "edit", "replace", { remove_from: "BBBB", remove_to: "BBBB", replacement_lines: ["    new();", "    extra();"] });
	assert.deepEqual(source(tracker, "edit"), { path, line: 2 });
	writeFileSync(path, "first();\n    new();\n    extra();\nlast();\n");
	end(tracker, "edit", "-BBBB│    old();\n+DDDD│    new();\n+EEEE│    extra();\n CCCC│last();");

	const restored = new ToolSourceTracker("session", cwd);
	assert.deepEqual(source(restored, "edit"), { path, line: 2 });
	start(restored, "next", "replace", { remove_from: "EEEE", remove_to: "EEEE", replacement_lines: ["    final();"] });
	assert.deepEqual(source(restored, "next"), { path, line: 3 });
	const messages = history([{ id: "edit", name: "replace", args: {} }]);
	const annotated = restored.annotate(messages);
	const parent = annotated[0].blocks[0];
	assert.ok(parent.kind === "tool");
	assert.deepEqual(parent.children?.[0].source, { path, line: 2 });
	assert.ok(messages[0].blocks[0].kind === "tool" && messages[0].blocks[0].children?.[0].source === undefined);
	const partial = reducePartial(emptyPartial(), restored.event({ type: "tool_start", id: "edit", name: "replace", args: {} }));
	const done = reducePartial(partial, { type: "tool_end", id: "edit", name: "replace", result: "", isError: false });
	assert.deepEqual(done.tools[0].source, { path, line: 2 });
});

test("reads capture actual slice positions, not guessed pagination offsets; changed files are rechecked", (t) => {
	const { cwd, tracker } = harness(t);
	const path = join(cwd, "app.ts");
	writeFileSync(path, "first();\nold();\nlast();\n");
	start(tracker, "read", "read_symbol", { path, symbol: "old", offset: 999 });
	end(tracker, "read", "BBBB│old();");
	writeFileSync(path, "inserted();\nfirst();\nold();\nlast();\n");
	start(tracker, "edit", "replace", { remove_from: "BBBB", remove_to: "BBBB", replacement_lines: ["new();"] });
	assert.deepEqual(source(tracker, "edit"), { path, line: 3 });
});

test("ambiguous anchor tokens across files cannot invent a resolved path", (t) => {
	const { cwd, tracker } = harness(t);
	for (const file of ["a.ts", "b.ts"]) {
		const path = join(cwd, file);
		writeFileSync(path, "same();\n");
		start(tracker, file, "read", { path });
		end(tracker, file, "AAAA│same();");
	}
	start(tracker, "edit", "replace", { remove_from: "AAAA", remove_to: "AAAA", replacement_lines: ["new();"] });
	assert.equal(source(tracker, "edit"), undefined);
});

test("historical lookup is exact, bounded to referenced files and explicitly current, not historical", (t) => {
	const { cwd, tracker } = harness(t);
	const path = join(cwd, "app.py");
	writeFileSync(path, "# header\nprint('new')\n");
	const messages = history([
		{ id: "read", name: "read", args: { path: "app.py" }, outputUnavailable: true },
		{ id: "edit", name: "replace", args: { remove_from: "AAAA", remove_to: "AAAA", replacement_lines: ["print('new')"] } },
	]);
	tracker.recover(messages);
	assert.deepEqual(source(tracker, "edit"), { path, currentLine: 2 });
	assert.deepEqual(source(new ToolSourceTracker("session", cwd), "edit"), { path, currentLine: 2 });
	writeFileSync(path, "# header\nprint('new')\nprint('new')\n");
	tracker.recover(messages);
	assert.deepEqual(source(tracker, "edit"), { path });
});

test("duplicates across referenced files and substring-only matches remain unresolved", (t) => {
	const { cwd, tracker } = harness(t);
	const reads: PiTool[] = [];
	for (const file of ["a.ts", "b.ts"]) {
		writeFileSync(join(cwd, file), "new();\n");
		reads.push({ id: file, name: "read", args: { path: file } });
	}
	const edit = { id: "edit", name: "replace", args: { remove_from: "AAAA", remove_to: "AAAA", replacement_lines: ["new();"] } };
	tracker.recover(history([...reads, edit]));
	assert.equal(source(tracker, "edit"), undefined);
	writeFileSync(join(cwd, "a.ts"), "new();\nnew();\n");
	tracker.recover(history([...reads, edit]));
	assert.equal(source(tracker, "edit"), undefined, "a repeated match in one file cannot be ignored in favour of another file");
	writeFileSync(join(cwd, "a.ts"), "prefix new(); suffix\n");
	writeFileSync(join(cwd, "b.ts"), "different();\n");
	tracker.recover(history([...reads, edit]));
	assert.equal(source(tracker, "edit"), undefined);
});

test("corrupt sidecars and failed read results are harmless", (t) => {
	const { cwd, tracker } = harness(t);
	const path = join(cwd, "app.ts");
	writeFileSync(path, "old();\n");
	start(tracker, "read", "read", { path });
	end(tracker, "read", "AAAA│old();", true);
	start(tracker, "edit", "replace", { remove_from: "AAAA", remove_to: "AAAA", replacement_lines: ["new();"] });
	assert.equal(source(tracker, "edit"), undefined);
	tracker.recover(history([{ id: "old-edit", name: "replace", args: { path, remove_from: "AAAA", remove_to: "AAAA", replacement_lines: ["old();"] } }]));
	const saved = readdirSync(cwd).find((file) => file.startsWith("tool-sources-"));
	assert.ok(saved);
	writeFileSync(join(cwd, saved), "{broken");
	assert.equal(source(new ToolSourceTracker("session", cwd), "old-edit"), undefined);
});

test("recorded nested reads rebuild anchor mappings for future edits after adoption", (t) => {
	const { cwd, tracker } = harness(t);
	const path = join(cwd, "app.ts");
	writeFileSync(path, "first();\nold();\nlast();\n");
	const messages = history([{ id: "read", name: "read", args: { path }, outputUnavailable: true }]);
	const parent = messages[0].blocks[0];
	assert.ok(parent.kind === "tool");
	parent.result = "AAAA│first();\nBBBB│old();\nCCCC│last();";
	tracker.recover(messages);
	start(tracker, "edit", "replace", { remove_from: "BBBB", remove_to: "BBBB", replacement_lines: ["new();"] });
	assert.deepEqual(source(tracker, "edit"), { path, line: 2 });
});

test("failed edits never acquire a recovered current location", (t) => {
	const { cwd, tracker } = harness(t);
	const path = join(cwd, "app.ts");
	writeFileSync(path, "new();\n");
	tracker.recover(history([{ id: "failed", name: "replace", args: { path, replacement_lines: ["new();"] }, isError: true }]));
	assert.equal(source(tracker, "failed"), undefined);
});
