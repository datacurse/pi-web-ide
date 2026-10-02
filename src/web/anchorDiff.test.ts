import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorDiff, anchorSources } from "./anchorDiff.js";

test("read anchors resolve the language path across codemode batches and edit results", () => {
	const sources = anchorSources([
		{ kind: "tool", id: "read-batch", name: "codemode", args: {}, children: [
			{ id: "read", name: "read", args: { path: "src/app.py" }, result: "RNMT│print(1)" },
		] },
		{ kind: "tool", id: "edit-batch", name: "codemode", args: {}, children: [
			{ id: "edit", name: "replace", args: { remove_from: "RNMT", remove_to: "RNMT", replacement_lines: ["print(2)"] }, result: "-RNMT│print(1)\n+ABCD│print(2)" },
			{ id: "next", name: "replace", args: { remove_from: "ABCD", remove_to: "ABCD", replacement_lines: ["print(3)"] } },
		] },
	]);
	assert.equal(sources.get("edit")?.path, "src/app.py");
	assert.equal(sources.get("next")?.path, "src/app.py");
});

test("incomplete recorded ranges are unavailable rather than guessed", () => {
	const tool = { id: "edit", name: "replace", args: { remove_from: "AAAA", remove_to: "ZZZZ", replacement_lines: [] },
		result: "-AAAA│first\n+BBBB│new\n-ZZZZ│unrelated" };
	assert.equal(anchorDiff(tool)?.removed, undefined);
});

test("empty removed source lines and explicit paths are preserved", () => {
	const diff = anchorDiff({ id: "edit", name: "replace", args: { path: "app.ts", remove_from: "AAAA", remove_to: "BBBB", replacement_lines: [] },
		result: "-AAAA│\n-BBBB│\told();" }, { path: "wrong.py" });
	assert.deepEqual(diff?.removed, ["", "\told();"]);
	assert.equal(diff?.path, "app.ts");
});

test("retained execution metadata takes priority over inferred anchor paths", () => {
	const tool = { id: "edit", name: "replace", args: { remove_from: "AAAA", remove_to: "AAAA", replacement_lines: ["new();"] },
		source: { path: "/project/src/app.py", line: 242 } };
	const diff = anchorDiff(tool, { path: "wrong.ts", currentLine: 7 });
	assert.equal(diff?.path, "/project/src/app.py");
	assert.equal(diff?.line, 242);
	assert.equal(anchorSources([{ kind: "tool", ...tool }]).get("edit")?.line, 242);
});
