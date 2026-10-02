import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionTodos, todoTasks } from "./todos.js";
import type { PiMessage, PiTool } from "./types.js";
import { stitch, toEvents, toPiMessage } from "../server/agent.js";

const tasks = [{ id: 1, subject: "Render todos", status: "in_progress" as const, activeForm: "Rendering todos" }];
const partial = { text: "", thinking: "", tools: [] };
const message = (tools: PiTool[]): PiMessage => ({ role: "assistant", timestamp: 1, blocks: tools.map((tool) => ({ kind: "tool", ...tool })) });

test("reads validated full snapshots, including clear and deleted tasks", () => {
	assert.deepEqual(todoTasks("todo", { tasks }), tasks);
	assert.deepEqual(todoTasks("todo", { tasks: [] }), []);
	assert.equal(todoTasks("bash", { tasks }), undefined);
	for (const invalid of [null, {}, { tasks: [null] }, { tasks: [{ id: 1, subject: "bad", status: "unknown" }] }]) {
		assert.equal(todoTasks("todo", invalid), undefined);
	}
});

test("todo details survive live events and saved-message stitching", () => {
	const events = toEvents({ type: "tool_execution_end", toolCallId: "t", toolName: "todo", result: { content: [], details: { tasks } } });
	assert.deepEqual(events[0].type === "tool_end" && events[0].todos, tasks);
	const result = toPiMessage({ role: "toolResult", timestamp: 2, toolCallId: "t", toolName: "todo", content: [], details: { tasks } } as never);
	const saved = stitch([message([{ id: "t", name: "todo", args: {} }]), result]);
	assert.deepEqual(sessionTodos(saved, partial), tasks);
	assert.deepEqual(sessionTodos(saved, { ...partial, tools: [{ id: "clear", name: "todo", args: {}, todos: [] }] }), []);
});

test("restores successful nested codemode tasks and ignores failures and interrupted calls", () => {
	const child = (id: string, args: unknown, extra = {}): PiTool => ({ id, name: "todo", args, outputUnavailable: true, ...extra });
	const saved = [message([{ id: "c", name: "codemode", args: {}, children: [
		child("c/1", { action: "create", subject: "Render todos" }),
		child("c/2", { action: "update", id: 1, status: "in_progress", activeForm: "Rendering todos" }),
		child("c/3", { action: "clear" }, { isError: true }),
		child("c/4", { action: "clear" }, { interrupted: true }),
	] }])];
	assert.deepEqual(sessionTodos(saved, partial), tasks);
	assert.deepEqual(sessionTodos(saved, { ...partial, tools: [{ id: "c/5", name: "todo", args: {}, todos: [{ ...tasks[0], status: "completed" }] }] }), [{ ...tasks[0], status: "completed" }]);
});

test("nested deletes, clear and ID reset", () => {
	const tools = [
		{ action: "create", subject: "Old" },
		{ action: "delete", id: 1 },
		{ action: "clear" },
		{ action: "create", subject: "New" },
	].map((args, i) => ({ id: String(i), name: "todo", args, outputUnavailable: true }));
	assert.deepEqual(sessionTodos([message(tools)], partial), [{ id: 1, subject: "New", status: "pending" }]);
});
