import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import generation from "./generation-extension.js";

 test("generation times streamed output only and resets between messages", (t) => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	const handlers = new Map<string, (event: never) => void>();
	const entries: unknown[] = [];
	generation({
		on(event, handler) { handlers.set(event, handler); },
		appendEntry(type, data) { entries.push({ type, data }); },
	});
	const emit = (type: string, event: object) => handlers.get(type)!(event as never);
	const delta = (type: string, text = "x") => emit("message_update", { assistantMessageEvent: { type, delta: text } });
	emit("message_start", { message: { role: "assistant" } });
	now = 5000;
	delta("thinking_delta");
	now = 6000;
	delta("text_delta");
	now = 7000;
	delta("toolcall_delta");
	now = 9000;
	delta("text_end");
	delta("text_delta", "");
	emit("message_end", { message: { role: "assistant", timestamp: 123, usage: { output: 100 } } });
	assert.deepEqual(entries, [{ type: "pwi-generation", data: { timestamp: 123, ms: 2000, tokens: 100 } }]);
	emit("message_end", { message: { role: "toolResult" } });
	now = 20000;
	emit("message_start", { message: { role: "assistant" } });
	delta("text_delta");
	emit("message_end", { message: { role: "assistant", timestamp: 456, usage: { output: 2 } } });
	assert.equal(entries.length, 1, "single buffered chunks cannot measure a rate");
	emit("message_start", { message: { role: "assistant" } });
	delta("text_delta");
	now = 21000;
	delta("text_delta");
	emit("message_end", { message: { role: "assistant", timestamp: 789, usage: { output: 20 } } });
	assert.deepEqual(entries[1], { type: "pwi-generation", data: { timestamp: 789, ms: 1000, tokens: 20 } });
});
