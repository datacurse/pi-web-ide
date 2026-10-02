import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { RU } from "./i18n.ru.js";
import { ATTENTION_UI } from "./attention.js";
import { SHORTCUTS } from "./shortcuts.js";
import { ASK_MODES, SESSION_SORTS, USER_MODES } from "./prefs.js";

const STR = String.raw`"(?:[^"\\]|\\.)*"`;

/** Every literal key passed to `t` or as `plural`'s `other` form in src/web. */
function keys(): Set<string> {
	const dir = new URL(".", import.meta.url);
	const out = new Set<string>();
	for (const f of readdirSync(dir)) {
		if (!/\.tsx?$/.test(f) || f.includes(".test.") || f.startsWith("i18n")) continue;
		const src = readFileSync(new URL(f, dir), "utf8");
		for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*(${STR})`, "g"))) out.add(JSON.parse(m[1]));
		for (const m of src.matchAll(new RegExp(String.raw`\bplural\(\s*[^,"]+,\s*${STR},\s*(${STR})`, "g")))
			out.add(JSON.parse(m[1]));
	}
	// Tables translated where they render.
	for (const m of USER_MODES) out.add(m.label).add(m.hint);
	for (const m of ASK_MODES) out.add(m.label).add(m.hint);
	for (const s of SESSION_SORTS) out.add(s.label);
	for (const s of SHORTCUTS) out.add(s.label);
	for (const a of Object.values(ATTENTION_UI)) out.add(a.label);
	return out;
}

test("every interface string has a Russian translation", () => {
	const missing = [...keys()].filter((k) => !(k in RU));
	assert.deepEqual(missing, []);
});

test("Russian plurals have three forms", () => {
	const dir = new URL(".", import.meta.url);
	for (const f of readdirSync(dir).filter((f) => /\.tsx?$/.test(f))) {
		const src = readFileSync(new URL(f, dir), "utf8");
		for (const m of src.matchAll(new RegExp(String.raw`\bplural\(\s*[^,"]+,\s*${STR},\s*(${STR})`, "g"))) {
			const key = JSON.parse(m[1]) as string;
			if (key in RU) assert.equal(RU[key].split("|").length, 3, key);
		}
	}
});
