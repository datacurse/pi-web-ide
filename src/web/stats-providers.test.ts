import assert from "node:assert/strict";
import type { StatsTurn } from "../shared/types.js";
import { filterTurns, modelComparisons, modelKey, usageLimitLabel } from "./stats.js";

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
assert.equal(rows[0]?.key, "openai-codex/same-id");
assert.equal(rows[0]?.prompts, 2);
assert.equal(rows[0]?.median, 5000);
assert.equal(rows[0]?.p90, 5000);
assert.equal(rows[0]?.input, 60);
assert.equal(rows[0]?.tools, 2);
assert.ok(Math.abs(rows[0]!.cost - 0.3) < 1e-9);
assert.equal(rows[0]?.errors, 1);
assert.equal(rows[0]?.aborted, 1);
assert.equal(rows.find((r) => r.key === "@mixed")?.prompts, 1);
assert.equal(modelKey({ ...base, provider: "" }), "@unknown/same-id");
const window = { kind: "openai_primary_window", percent: 1, resets_at: null, scope: null };
assert.equal(usageLimitLabel({ ...window, windowMs: 604_800_000 }), "This week");
assert.equal(usageLimitLabel({ ...window, windowMs: 18_000_000 }), "Current session");
assert.equal(usageLimitLabel({ ...window, windowMs: 1_800_000 }), "30m window");
assert.equal(usageLimitLabel(window), "Current session");
