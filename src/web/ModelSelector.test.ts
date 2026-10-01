import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelSelector } from "./ModelSelector.js";

const props = {
	model: "openai-codex/gpt-6.1-sol",
	disabled: false,
	onChange: () => {},
	thinkingLevel: "minimal",
	thinkingLevels: ["minimal", "low", "medium"],
	onThinkingChange: () => {},
};

test("resumed Sol aliases select low without offering duplicate minimal", () => {
	const html = renderToStaticMarkup(createElement(ModelSelector, {
		...props, thinkingLevelMap: { minimal: "low", low: "low", medium: "medium" },
	}));
	assert.doesNotMatch(html, /<option value="minimal"/);
	assert.match(html, /<option value="low" selected=""/);
	assert.match(html, /<option value="medium"/);
});

test("Fast is an explicit opt-in with a visible usage warning", () => {
	const render = (fastMode: boolean | undefined, disabled = false) => renderToStaticMarkup(createElement(ModelSelector, {
		...props, fastMode, disabled, onFastChange: async () => {},
	}));
	assert.match(render(false), /aria-pressed="false"/);
	assert.match(render(false), /Fast · 2.5× usage/);
	assert.match(render(true), /aria-pressed="true"/);
	assert.match(render(undefined), /Restart this session to use Fast mode/);
	assert.match(render(undefined), /aria-pressed="false" disabled=""/);
	assert.match(render(true, true), /aria-pressed="true" disabled=""/);
	const other = renderToStaticMarkup(createElement(ModelSelector, {
		...props, model: "anthropic/claude-opus-5-5", fastMode: true, onFastChange: async () => {},
	}));
	assert.doesNotMatch(other, /Fast ·/);
});

test("other models retain distinct minimal and low options", () => {
	const html = renderToStaticMarkup(createElement(ModelSelector, props));
	assert.match(html, /<option value="minimal" selected=""/);
	assert.match(html, /<option value="low"/);
});
