import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeLiveTools, nestTools } from "./toolTree.js";
import type { PiMessage, PiTool } from "./types.js";

const tool = (id: string, parentId?: string): PiTool => ({ id, parentId, name: "read", args: {} });
test("batches nest recursively, tolerate out-of-order events, and never mutate inputs", () => {
	const input = [tool("batch/1/1", "batch/1"), tool("batch"), tool("batch/1", "batch")];
	const before = structuredClone(input);
	const roots = nestTools(input);
	assert.equal(roots.length, 1);
	assert.equal(roots[0].id, "batch");
	assert.equal(roots[0].children?.[0].children?.[0].id, "batch/1/1");
	assert.deepEqual(input, before);
	assert.equal(nestTools(roots)[0].children?.length, 1);
});
test("missing parents and cycles cannot hide calls or create recursive render loops", () => {
	assert.equal(nestTools([tool("orphan", "absent")]).length, 1);
	const cyclic = nestTools([tool("a", "b"), tool("b", "a")]);
	assert.equal(cyclic.length, 2);
	assert.ok(cyclic.every((call) => !call.children));
});
test("live children attach to an existing transcript parent without duplicated sibling cards", () => {
	const messages: PiMessage[] = [{ role: "assistant", timestamp: 1, blocks: [{kind:"tool", ...tool("batch")}] }];
	const merged = mergeLiveTools(messages, [tool("batch"), { ...tool("batch/1", "batch"), result:"file body", durationMs:30 }]);
	assert.equal(merged.liveTools.length, 0);
	const block = merged.messages[0].blocks[0];
	assert.ok(block.kind === "tool");
	assert.equal(block.children?.[0].result, "file body");
	assert.equal(block.children?.[0].durationMs, 30);
	assert.ok(messages[0].blocks[0].kind === "tool" && !messages[0].blocks[0].children);
});
test("reconnecting after a parent's start still attaches children to its transcript call", () => {
	const messages: PiMessage[] = [{role:"assistant",timestamp:1,blocks:[{kind:"tool",...tool("batch")}]}];
	const merged = mergeLiveTools(messages,[{...tool("batch/1","batch"),result:"body"}]);
	assert.equal(merged.liveTools.length,0);
	const parent = merged.messages[0].blocks[0];
	assert.ok(parent.kind === "tool");
	assert.equal(parent.children?.[0].result,"body");
});
test("a late partial cannot discard retained siblings and can supply their missing live output", () => {
	const messages: PiMessage[] = [{role:"assistant",timestamp:1,blocks:[{kind:"tool",...tool("batch"),result:"done",children:[
		{...tool("batch/1","batch"),result:"",outputUnavailable:true,durationMs:50},
		{...tool("batch/2","batch"),result:"",durationMs:70},
	]}]}];
	const parent = mergeLiveTools(messages,[{...tool("batch/1","batch"),result:"live body"}]).messages[0].blocks[0];
	assert.ok(parent.kind === "tool");
	assert.equal(parent.children?.length,2);
	assert.equal(parent.children?.[0].result,"live body");
	assert.equal(parent.children?.[0].durationMs,50);
	assert.equal(parent.children?.[0].outputUnavailable,undefined);
});
test("persisted parent outcomes remain authoritative over a stale partial", () => {
	const messages: PiMessage[] = [{role:"assistant",timestamp:1,blocks:[{kind:"tool",...tool("batch"),result:"done",isError:true}]}];
	const block = mergeLiveTools(messages,[{...tool("batch"),result:"partial",isError:false}]).messages[0].blocks[0];
	assert.ok(block.kind === "tool");
	assert.equal(block.result,"done");
	assert.equal(block.isError,true);
});

test("saved source locations survive partial tools that have no execution metadata", () => {
	const source = { path: "/project/app.ts", line: 42 };
	const messages: PiMessage[] = [{ role: "assistant", timestamp: 1, blocks: [{ kind: "tool", ...tool("batch"), children: [
		{ ...tool("batch/1", "batch"), source, outputUnavailable: true },
	] }] }];
	const parent = mergeLiveTools(messages, [{ ...tool("batch/1", "batch"), source: undefined, result: "done" }]).messages[0].blocks[0];
	assert.ok(parent.kind === "tool");
	assert.deepEqual(parent.children?.[0].source, source);
});
