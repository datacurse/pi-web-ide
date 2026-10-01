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

test("system and custom messages do not extend completed turns", async () => {
	for (const role of ["system", "custom"]) {
		const p = await parseLines([
			msg("2026-01-01T00:00:00Z", { role: "user", content: "first" }),
			msg("2026-01-01T00:00:05Z", { role: "assistant", stopReason: "stop", content: [] }),
			msg("2026-01-01T00:25:00Z", { role, content: "reminder" }),
			msg("2026-01-01T00:25:01Z", { role: "user", content: "second" }),
			msg("2026-01-01T00:25:03Z", { role: "assistant", stopReason: "stop", content: [] }),
			msg("2026-01-01T00:50:00Z", { role, content: "reminder" }),
		]);
		assert.deepEqual(p.turns.map((t) => t.ms), [5000, 2000], role);
	}
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
	assert.equal(t?.costs.read?.measured, 0);
	assert.equal(t?.outliers[0]?.preview, "cd x && git status");
});

test("measured calls use the collector's time instead of the estimate", async () => {
	const p = await parseLines(
		[
			msg("2026-01-01T00:00:00Z", { role: "user", content: "go", timestamp: Date.parse("2026-01-01T00:00:00Z") }),
			msg("2026-01-01T00:00:02Z", {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "toolCall", id: "a", name: "edit", arguments: { path: "f" } },
					{ type: "toolCall", id: "b", name: "read", arguments: { path: "g" } },
				],
			}),
			msg("2026-01-01T00:00:06Z", { role: "toolResult", toolCallId: "a", content: [], timestamp: Date.parse("2026-01-01T00:00:06Z") }),
			msg("2026-01-01T00:00:06Z", { role: "toolResult", toolCallId: "b", content: [], timestamp: Date.parse("2026-01-01T00:00:06Z") }),
			msg("2026-01-01T00:00:08Z", { role: "assistant", stopReason: "stop", content: [] }),
		],
		{
			calls: new Map([["a", { v: 1, toolCallId: "a", tool: "edit", ms: 3900, hookMs: 3800, at: 0 }]]),
			background: new Map(),
		},
	);
	const [t] = p.turns;
	assert.deepEqual(
		{ ms: t?.costs.edit?.ms, hookMs: t?.costs.edit?.hookMs, measured: t?.costs.edit?.measured },
		{ ms: 3900, hookMs: 3800, measured: 1 },
	);
	assert.equal(t?.costs.read?.ms, 2000);
});

test("a measured bash call counts per command, the shell's own time apart", async () => {
	const command = "cd x && cat f; sleep 1 &";
	const p = await parseLines(
		[
			msg("2026-01-01T00:00:00Z", { role: "user", content: "go", timestamp: Date.parse("2026-01-01T00:00:00Z") }),
			msg("2026-01-01T00:00:02Z", {
				role: "assistant",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command } }],
			}),
			msg("2026-01-01T00:00:03Z", {
				role: "toolResult",
				toolCallId: "a",
				content: [{ type: "text", text: "y".repeat(400) }],
				timestamp: Date.parse("2026-01-01T00:00:03Z"),
			}),
			msg("2026-01-01T00:00:04Z", { role: "assistant", stopReason: "stop", content: [] }),
		],
		{
			calls: new Map([
				[
					"a",
					{
						v: 1,
						toolCallId: "a",
						tool: "bash",
						ms: 120,
						hookMs: 2,
						at: 0,
						steps: [
							{ text: "cd x", ms: 0.1, exit: 0, bytes: 0, shown: 0 },
							{ text: "cat f", ms: 19.9, exit: 0, bytes: 400, shown: 400 },
							{ text: "sleep 1", ms: 0.5, exit: 0, bytes: 0, shown: 0 },
						],
					},
				],
			]),
			background: new Map([["a", [{ v: 1, type: "background", toolCallId: "a", tool: "bash", pid: 9, step: 2, ms: 1000, at: 0 }]]]),
		},
	);
	const [t] = p.turns;
	assert.deepEqual(Object.keys(t?.costs ?? {}).sort(), ["bash: (shell)", "bash: cat", "bash: cd", "bash: sleep"]);
	assert.equal(t?.costs["bash: cat"]?.ms, 19.9);
	assert.ok((t?.costs["bash: cat"]?.tokens ?? 0) > 95);
	assert.equal(t?.costs["bash: (shell)"]?.ms, 120 - 20.5);
	assert.equal(t?.costs["bash: (shell)"]?.hookMs, 2);
	assert.deepEqual(t?.background, [{ text: "sleep 1", ms: 1000 }]);
	assert.equal(t?.outliers.find((o) => o.ms === 19.9)?.preview, "cat f");
});

test("codemode nested tools are broken out from the wrapper", async () => {
	const p = await parseLines([
		msg("2026-01-01T00:00:00Z", { role: "user", content: "go", timestamp: Date.parse("2026-01-01T00:00:00Z") }),
		msg("2026-01-01T00:00:01Z", { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "parent", name: "codemode", arguments: { code: "await tools.read({path: 'a'})" } }] }),
		msg("2026-01-01T00:00:03Z", { role: "toolResult", toolCallId: "parent", content: [{ type: "text", text: "done" }], nestedCalls: { complete: true, calls: [
			{ id: "parent/1", name: "read", arguments: { path: "a.ts" }, status: "ok", durationMs: 120 },
			{ id: "parent/2", name: "bash", arguments: { command: "git status" }, status: "ok", durationMs: 80 },
		] } }),
		msg("2026-01-01T00:00:04Z", { role: "assistant", stopReason: "stop", content: [] }),
	]);
	const costs = p.turns[0]?.costs;
	assert.equal(costs?.read?.calls, 1);
	assert.equal(costs?.read?.ms, 120);
	assert.equal(costs?.["bash: git status"]?.ms, 80);
	assert.equal(costs?.["codemode: (wrapper)"]?.calls, 1);
	assert.equal(costs?.codemode, undefined);
});
