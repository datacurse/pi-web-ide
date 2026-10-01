import assert from "node:assert/strict";
import type { StatsTurn } from "../shared/types.js";
import { filterTurns, modelComparisons, modelKey, tokensPerSecond, turnMode, turnModeLabel, usageLimitLabel } from "./stats.js";

const base: StatsTurn = {
	session: "s", cwd: "/p", start: 1, ms: 1000,
	provider: "anthropic", model: "same-id", mixedModels: false,
	inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30,
	prompt: "go", tools: { read: 2 }, costs: {}, outliers: [], background: [],
	outputTokens: 5, cost: 0.1, outcome: "stop", machine: "",
};
const turns = [base, { ...base, provider: "openai-codex", ms: 3000, cost: 0.2, outcome: "error" }, { ...base, provider: "openai-codex", ms: 5000, cost: 0.4, outcome: "aborted" }, { ...base, mixedModels: true }];
assert.notEqual(modelKey(turns[0]!), modelKey(turns[1]!));
assert.equal(filterTurns(turns, "openai-codex", "").length, 2);
assert.equal(filterTurns(turns, "anthropic", "").length, 1);
assert.equal(filterTurns(turns, "", modelKey(base)).length, 1);
assert.equal(filterTurns(turns, "", "").length, 4);
const rows = modelComparisons(turns);
assert.equal(rows.length, 3);
assert.equal(rows[0]?.key, "openai-codex/same-id:standard");
assert.equal(rows[0]?.prompts, 2);
assert.equal(rows[0]?.tps, undefined);
assert.equal(tokensPerSecond(base), undefined);
assert.equal(tokensPerSecond({ ...base, generationMs: 0 }), undefined);
assert.equal(tokensPerSecond({ ...base, generationMs: NaN }), undefined);
assert.equal(tokensPerSecond({ ...base, generationMs: 500 }), 10);
const timed = modelComparisons([
	{ ...base, generationMs: 500 },
	{ ...base, generationMs: 1500, outputTokens: 15 },
	base,
]);
assert.equal(timed[0]?.tps, 10);
assert.equal(timed[0]?.tpsSamples, 2);
assert.equal(rows[0]?.median, 5000);
assert.equal(rows[0]?.p90, 5000);
assert.equal(rows[0]?.input, 60);
assert.equal(rows[0]?.tools, 2);
assert.ok(Math.abs(rows[0]!.cost - 0.3) < 1e-9);
assert.equal(rows[0]?.errors, 1);
assert.equal(rows[0]?.aborted, 1);
assert.equal(rows.find((r) => r.key === "@mixed:unknown")?.prompts, 1);
assert.equal(modelKey({ ...base, provider: "" }), "@unknown/same-id");
const sol = { ...base, provider: "openai-codex", model: "gpt-6.1-sol", generationMs: 1000 };
const modes: StatsTurn[] = [
	{ ...sol, fastMode: false, outputTokens: 10 },
	{ ...sol, fastMode: true, outputTokens: 30 },
	{ ...sol, fastMode: true, outputTokens: 50 },
	sol,
	{ ...sol, mixedFastMode: true },
];
assert.deepEqual(modes.map(turnMode), ["standard", "fast", "fast", "unknown", "mixed"]);
assert.equal(turnModeLabel(modes[1]!), "Fast mode");
assert.equal(filterTurns(modes, "openai-codex", modelKey(sol), "fast").length, 2);
assert.equal(filterTurns(modes, "", "", "standard").length, 1);
assert.equal(filterTurns(modes, "", "", "unknown").length, 1);
assert.equal(filterTurns(modes, "", "", "mixed").length, 1);
const comparisons = modelComparisons(modes);
assert.equal(comparisons.length, 4);
assert.equal(comparisons.find((row) => row.key.endsWith(":fast"))?.tps, 40);
assert.equal(comparisons.find((row) => row.key.endsWith(":fast"))?.prompts, 2);
assert.equal(comparisons.find((row) => row.key.endsWith(":standard"))?.tps, 10);
assert.match(comparisons.find((row) => row.key.endsWith(":unknown"))!.label, /Unknown mode/);
const window = { kind: "openai_primary_window", percent: 1, resets_at: null, scope: null };
assert.equal(usageLimitLabel({ ...window, windowMs: 604_800_000 }), "This week");
assert.equal(usageLimitLabel({ ...window, windowMs: 18_000_000 }), "Current session");
assert.equal(usageLimitLabel({ ...window, windowMs: 1_800_000 }), "30m window");
assert.equal(usageLimitLabel(window), "Current session");
