import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLines } from "./stats.js";

const msg = (ts: string, message: object) =>
	JSON.stringify({ type: "message", timestamp: ts, message });

test("one turn per user prompt, timed to its last message", async () => {
	const p = await parseLines([
		JSON.stringify({ type: "session", id: "s1", cwd: "/p" }),
		msg("2026-01-01T00:00:00.500Z", {
			role: "user",
			content: [{ type: "text", text: "hi" }],
			timestamp: Date.parse("2026-01-01T00:00:00Z"),
		}),
		msg("2026-01-01T00:00:05Z", {
			role: "assistant",
			model: "m",
			stopReason: "toolUse",
			usage: { output: 10, cost: { total: 0.5 } },
			content: [{ type: "toolCall", name: "bash" }],
		}),
		msg("2026-01-01T00:00:06Z", { role: "toolResult" }),
		msg("2026-01-01T00:00:09Z", {
			role: "assistant",
			model: "m",
			stopReason: "stop",
			usage: { output: 5, cost: { total: 0.25 } },
			content: [],
		}),
		// Unanswered prompt: dropped.
		msg("2026-01-01T00:01:00Z", { role: "user", content: [{ type: "text", text: "again" }] }),
		"{torn",
	]);
	assert.equal(p.id, "s1");
	assert.equal(p.turns.length, 1);
	const [t] = p.turns;
	assert.equal(t?.ms, 9000);
	assert.equal(t?.prompt, "hi");
	assert.equal(t?.outcome, "stop");
	assert.equal(t?.outputTokens, 15);
	assert.equal(t?.cost, 0.75);
	assert.deepEqual(t?.tools, { bash: 1 });
});

test("tool calls cost their size and their wait, split across a batch", async () => {
	const p = await parseLines([
		msg("2026-01-01T00:00:00Z", { role: "user", content: "go", timestamp: Date.parse("2026-01-01T00:00:00Z") }),
		msg("2026-01-01T00:00:02Z", {
			role: "assistant",
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "cd x && git status" } },
				{ type: "toolCall", id: "b", name: "read", arguments: { path: "f" } },
			],
		}),
		msg("2026-01-01T00:00:06Z", {
			role: "toolResult",
			toolCallId: "a",
			content: [{ type: "text", text: "x".repeat(400) }],
			timestamp: Date.parse("2026-01-01T00:00:06Z"),
		}),
		msg("2026-01-01T00:00:06Z", {
			role: "toolResult",
			toolCallId: "b",
			content: [],
			timestamp: Date.parse("2026-01-01T00:00:06Z"),
		}),
		msg("2026-01-01T00:00:08Z", { role: "assistant", stopReason: "stop", content: [] }),
	]);
	const [t] = p.turns;
	const bash = t?.costs["bash: git status"];
	assert.equal(bash?.calls, 1);
	assert.equal(bash?.ms, 2000);
	assert.equal(bash?.tokens, Math.ceil((4 + JSON.stringify({ command: "cd x && git status" }).length + 400) / 4));
	assert.equal(t?.costs.read?.ms, 2000);
	assert.equal(t?.outliers[0]?.preview, "cd x && git status");
});
