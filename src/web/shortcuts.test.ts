import { test } from "node:test";
import assert from "node:assert/strict";
import { comboOf, formatCombo, isReserved, matchShortcut, SHORTCUTS, type Bindings } from "./shortcuts.js";

const key = (code: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
	code,
	ctrlKey: !!mods.ctrl,
	altKey: !!mods.alt,
	shiftKey: !!mods.shift,
	metaKey: !!mods.meta,
});
const defaults = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.keys])) as Bindings;

test("comboOf spells modifiers in order and ignores a lone modifier", () => {
	assert.equal(comboOf(key("KeyT", { shift: true, alt: true })), "Alt+Shift+KeyT");
	assert.equal(comboOf(key("AltLeft", { alt: true })), null);
	assert.equal(comboOf(key("Digit3", { alt: true }), true), "Alt+Digit");
});

test("matchShortcut finds exact bindings and the tab digit", () => {
	assert.deepEqual(matchShortcut(key("KeyN", { alt: true }), defaults), { id: "session.new", digit: 0 });
	assert.deepEqual(matchShortcut(key("Digit4", { alt: true }), defaults), { id: "tab.select", digit: 4 });
	assert.equal(matchShortcut(key("Digit0", { alt: true }), defaults), null);
	assert.equal(matchShortcut(key("KeyN", { alt: true, shift: true }), defaults), null);
	assert.equal(matchShortcut(key("KeyN", { alt: true }), { ...defaults, "session.new": "" }), null);
});

test("no default is a key the browser keeps", () => {
	for (const s of SHORTCUTS) assert.equal(isReserved(s.keys), false, s.id);
	assert.equal(isReserved("Ctrl+KeyT"), true);
});

test("formatCombo reads like a keyboard", () => {
	assert.equal(formatCombo("Alt+Shift+KeyT"), "Alt+Shift+T");
	assert.equal(formatCombo("Ctrl+Backquote"), "Ctrl+`");
	assert.equal(formatCombo("Alt+Digit"), "Alt+1\u20139");
});
