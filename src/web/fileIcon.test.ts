// Run: node --import tsx src/web/fileIcon.test.ts
//
// Names only. The React components resolve icon URLs through import.meta.glob,
// which is a Vite transform and does not exist under plain node — and the part
// worth testing is the mapping, not whether an <img> renders.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirIconNameFor, iconNameFor } from "./fileIcon.js";

// Extensions map to their language icon.
assert.equal(iconNameFor("App.tsx"), "react_ts");
assert.equal(iconNameFor("index.ts"), "typescript");
assert.equal(iconNameFor("main.py"), "python");
assert.equal(iconNameFor("style.css"), "css");
assert.equal(iconNameFor("Cargo.toml"), "settings");

// Case does not matter: a file is not a different type for being SHOUTED.
assert.equal(iconNameFor("README.MD"), iconNameFor("readme.md"));
assert.equal(iconNameFor("Main.PY"), "python");

// A whole-name match beats the extension. package.json is a Node icon, not a
// generic JSON one — the reason the name table is consulted first.
assert.equal(iconNameFor("package.json"), "nodejs");
assert.equal(iconNameFor("data.json"), "json");
assert.equal(iconNameFor("tsconfig.json"), "tsconfig");
assert.equal(iconNameFor("vite.config.ts"), "vite");

// THE dotfile case: `.gitignore`'s only dot is at index 0, so it has no
// extension. A naive lastIndexOf(".") reads "gitignore" as one and misses.
assert.equal(iconNameFor(".gitignore"), "git");
// An unregistered dotfile is unknown, not "extension = the whole name".
assert.equal(iconNameFor(".mystery"), "file");

// Unknown extensions still resolve — a tree must draw every file.
assert.equal(iconNameFor("data.xyzzy"), "file");
assert.equal(iconNameFor("noextension"), "file");
assert.equal(iconNameFor(""), "file");

// A multi-dot name uses the LAST segment.
assert.equal(iconNameFor("tabs.test.ts"), "typescript");

// Directories: known ones get their own icon, and open/closed differ.
assert.equal(dirIconNameFor("src", false), "folder-src");
assert.equal(dirIconNameFor("src", true), "folder-src-open");
assert.equal(dirIconNameFor("node_modules", false), "folder-node");
assert.equal(dirIconNameFor("whatever", false), "folder");
assert.equal(dirIconNameFor("whatever", true), "folder-open");
assert.equal(dirIconNameFor("web", false), "folder-client");

/*
 * Every name the tables can produce must have an SVG on disk. `folder-www`
 * and `folder-hooks` were both mapped to icons the package does not ship, and
 * a missing icon is an invisible 404 rather than an error.
 *
 * ponytail: the names are scraped out of the source rather than exported,
 * which keeps the module's API at two functions. Export the tables if
 * anything else ever needs them.
 */
if (existsSync("public/material-icons")) {
	const src = readFileSync("src/web/fileIcon.tsx", "utf8");
	for (const [, name] of src.matchAll(/:\s*"([\w.-]+)",/g)) {
		assert.ok(
			existsSync(`public/material-icons/${name}.svg`),
			`no icon file for "${name}"`,
		);
		if (name.startsWith("folder-"))
			assert.ok(
				existsSync(`public/material-icons/${name}-open.svg`),
				`no open icon file for "${name}"`,
			);
	}
}

console.log("fileIcon: ok");
