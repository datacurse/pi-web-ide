import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLines } from "./stats.js";

const start = Date.parse("2026-10-01T00:00:00Z");
const msg = (seconds: number, message: object) => JSON.stringify({ type: "message", timestamp: new Date(start + seconds * 1000).toISOString(), message });
const timing = (seconds: number, ms: number, tokens: number) => JSON.stringify({ type: "custom", customType: "pwi-generation", data: { timestamp: start + seconds * 1000, ms, tokens } });

test("generation timing aggregates model streams, not tool waits, and requires complete coverage", async () => {
	const assistant = (output: number, stopReason = "stop") => ({ role: "assistant", stopReason, usage: { output } });
	const p = await parseLines([
		msg(0, { role: "user", content: "measured" }),
		timing(10, 2000, 100),
		msg(10, assistant(100, "toolUse")),
		msg(50, { role: "toolResult" }),
		msg(60, assistant(50)),
		timing(60, 1000, 50),
		msg(61, { role: "user", content: "partial" }),
		msg(62, assistant(10, "toolUse")),
		timing(62, 100, 10),
		msg(63, assistant(10)),
		msg(64, { role: "user", content: "invalid" }),
		msg(65, assistant(10)),
		timing(65, -1, 10),
	]);
	assert.equal(p.turns[0]?.ms, 60000);
	assert.equal(p.turns[0]?.outputTokens, 150);
	assert.equal(p.turns[0]?.generationMs, 3000);
	assert.equal(p.turns[1]?.generationMs, undefined);
	assert.equal(p.turns[2]?.generationMs, undefined);
});

test("stats retain provider identity, all token types and mixed-model answers", async () => {
	const p = await parseLines([
		JSON.stringify({ type: "session", id: "s", cwd: "/p" }),
		msg(0, { role: "user", content: "first" }),
		msg(1, { role: "assistant", provider: "anthropic", model: "same-id", stopReason: "stop", usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 40, cost: { total: 0.2 } } }),
		msg(2, { role: "user", content: "second" }),
		msg(3, { role: "assistant", provider: "openai-codex", model: "same-id", stopReason: "stop", usage: { input: 20, output: 3, cost: { total: 0.3 } } }),
		msg(4, { role: "user", content: "mixed" }),
		msg(5, { role: "assistant", provider: "openai-codex", model: "same-id", stopReason: "toolUse", usage: { output: 4, cost: { total: 0.4 } } }),
		msg(6, { role: "assistant", provider: "anthropic", model: "same-id", stopReason: "stop", usage: { output: 5, cost: { total: 0.5 } } }),
	]);
	assert.equal(p.turns.length, 3);
	assert.equal(p.turns[0]?.provider, "anthropic");
	assert.equal(p.turns[1]?.provider, "openai-codex");
	assert.equal(p.turns[0]?.mixedModels, false);
	assert.equal(p.turns[1]?.mixedModels, false);
	assert.equal(p.turns[2]?.mixedModels, true);
	assert.equal(p.turns[2]?.outputTokens, 9);
	assert.equal(p.turns[2]?.cost, 0.9);
	assert.equal(p.turns[0]?.inputTokens, 10);
	assert.equal(p.turns[0]?.cacheReadTokens, 30);
	assert.equal(p.turns[0]?.cacheWriteTokens, 40);
});

test("model_change supplies identity for older messages; absent providers are not guessed", async () => {
	const p = await parseLines([
		msg(0, { role: "user", content: "old" }),
		msg(1, { role: "assistant", model: "claude-opus", stopReason: "stop" }),
		JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-6.1-sol" }),
		msg(2, { role: "user", content: "new" }),
		msg(3, { role: "assistant", stopReason: "stop" }),
	]);
	assert.equal(p.turns[0]?.provider, "");
	assert.equal(p.turns[1]?.provider, "openai-codex");
	assert.equal(p.turns[1]?.model, "gpt-6.1-sol");
	assert.equal(p.turns[1]?.mixedModels, false);
});
