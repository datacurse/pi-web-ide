import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import toolMetrics from "./collector.ts";
import { parseMetrics } from "./format.ts";

type Handler = (e: { toolCallId: string; toolName?: string }, ctx: unknown) => unknown;

async function load(dir: string | undefined) {
	const handlers = new Map<string, Handler>();
	const before = process.env.PWI_TOOL_METRICS_DIR;
	if (dir === undefined) delete process.env.PWI_TOOL_METRICS_DIR;
	else process.env.PWI_TOOL_METRICS_DIR = dir;
	// Outside pi its package does not resolve, so bash is left alone.
	await toolMetrics({ on: (name, h) => void handlers.set(name, h as Handler), registerTool: () => assert.fail() });
	if (before === undefined) delete process.env.PWI_TOOL_METRICS_DIR;
	else process.env.PWI_TOOL_METRICS_DIR = before;
	const ctx = { sessionManager: { getSessionId: () => "s1" } };
	return (name: string, id: string) => handlers.get(name)?.({ toolCallId: id, toolName: "edit" }, ctx);
}

test("one line per call, with the hook time after the result, returning nothing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tm-"));
	const fire = await load(dir);
	assert.equal(fire("tool_execution_start", "a"), undefined);
	assert.equal(fire("tool_result", "a"), undefined);
	fire("tool_execution_end", "a");
	fire("tool_execution_end", "never-started");
	const [r, ...rest] = parseMetrics(readFileSync(join(dir, "s1.jsonl"), "utf8"));
	assert.equal(rest.length, 0);
	assert.equal(r?.v, 1);
	assert.equal(r?.toolCallId, "a");
	assert.equal(r?.tool, "edit");
	assert.equal(typeof r?.ms, "number");
	assert.equal(typeof r?.hookMs, "number");
});

test("without a directory it registers nothing", async () => {
	const fire = await load(undefined);
	assert.equal(fire("tool_execution_start", "a"), undefined);
});

test("a failed write turns it off instead of throwing", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "tm-")), "a-file");
	writeFileSync(file, "");
	const fire = await load(join(file, "tool-metrics"));
	fire("tool_execution_start", "a");
	assert.doesNotThrow(() => fire("tool_execution_end", "a"));
});
