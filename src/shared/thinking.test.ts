import assert from "node:assert/strict";
import { test } from "node:test";
import { thinkingChoices } from "./thinking.js";

const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

test("Sol offers distinct provider efforts and resolves saved aliases", () => {
	const choices = thinkingChoices(levels, {
		off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
	});
	assert.deepEqual(choices.levels, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(choices.resolve("minimal"), "low");
	assert.equal(choices.resolve("low"), "low");
	assert.equal(choices.resolve(undefined), undefined);
	assert.equal(choices.resolve(null), null);
	assert.equal(choices.resolve("unknown"), "unknown");
});

test("models with distinct reasoning levels retain every choice", () => {
	const choices = thinkingChoices(levels, { minimal: "minimal", low: "low" });
	assert.deepEqual(choices.levels, levels);
	assert.equal(choices.resolve("minimal"), "minimal");
});

test("absent metadata preserves older-server choices", () => {
	assert.deepEqual(thinkingChoices(levels).levels, levels);
	assert.deepEqual(thinkingChoices([]).levels, []);
});

test("only supported levels can represent a shared effort", () => {
	const choices = thinkingChoices(["minimal", "medium", "high"], { minimal: "low", medium: "medium", high: "medium" });
	assert.deepEqual(choices.levels, ["minimal", "medium"]);
	assert.equal(choices.resolve("high"), "medium");
});

test("a model switch recomputes alias resolution without changing stored levels", () => {
	const sol = thinkingChoices(["minimal", "low"], { minimal: "low", low: "low" });
	const other = thinkingChoices(["minimal", "low"]);
	assert.equal(sol.resolve("minimal"), "low");
	assert.equal(other.resolve("minimal"), "minimal");
	assert.deepEqual(other.levels, ["minimal", "low"]);
});
