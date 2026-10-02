import { test } from "node:test";
import assert from "node:assert/strict";
import { locale, perLocale, plural, t } from "./i18n.js";

test("interface text stays English and fills placeholders", () => {
	assert.equal(t("Settings"), "Settings");
	assert.equal(t("Hello {name}", { name: "Alex" }), "Hello Alex");
	assert.equal(t("{n} files", { n: 3 }), "3 files");
	assert.equal(t("{missing}", {}), "{missing}");
});

test("English count phrases use singular only for one", () => {
	for (const n of [0, 1, 2, 5, 21]) {
		assert.equal(plural(n, "{n} file", "{n} files"), `${n} ${n === 1 ? "file" : "files"}`);
	}
	assert.equal(plural(2, "{n} file in {dir}", "{n} files in {dir}", { dir: "src" }), "2 files in src");
});

test("formatters use the browser locale and are created once", () => {
	assert.equal(locale(), undefined);
	let calls = 0;
	const formatter = perLocale((l) => {
		assert.equal(l, undefined);
		calls++;
		return new Intl.NumberFormat(l);
	});
	assert.equal(formatter(), formatter());
	assert.equal(calls, 1);
});
