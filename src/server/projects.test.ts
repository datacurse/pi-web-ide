// Run: node --import tsx src/server/projects.test.ts
import {
	addFavorite,
	addProject,
	browse,
	listFavorites,
	listProjects,
	removeFavorite,
	removeProject,
} from "./projects.js";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const seed = process.cwd();
assert(listProjects(seed).includes(seed), "seed always present");
const before = listProjects(seed);
assert.throws(() => addProject(seed, "/nope/nope/nope"), /not a directory/);
assert.throws(() => addProject(seed, "/etc/hostname"), /not a directory/);
const added = addProject(seed, "/tmp");
assert(added.includes("/tmp"), "add");
assert.deepEqual(addProject(seed, "/tmp"), added, "add is idempotent");
assert(!removeProject(seed, "/tmp").includes("/tmp"), "remove");
assert.deepEqual(listProjects(seed).sort(), before.sort(), "restored");

// browse: the picker's listing. Built in a temp tree so the assertions do not
// depend on whatever the machine happens to have in /tmp.
const root = mkdtempSync(join(tmpdir(), "piw-browse-"));
mkdirSync(join(root, "beta"));
mkdirSync(join(root, "alpha", ".git"), { recursive: true });
mkdirSync(join(root, ".hidden"));
writeFileSync(join(root, "file.txt"), "");

const listed = browse(root);
assert.deepEqual(
	listed.entries.map((e) => e.name),
	["alpha", "beta", ".hidden"],
	"directories only, dotted names last",
);
assert.deepEqual(
	listed.entries.map((e) => e.repo),
	[true, false, false],
	"a .git marks the checkout and nothing else",
);
assert.equal(listed.entries[0].path, join(root, "alpha"), "paths are absolute");
assert.equal(listed.parent, tmpdir(), "parent is one level up");
assert.equal(browse("/").parent, null, "the root has no parent");
assert.equal(browse("~").path, homedir(), "~ expands");
assert.equal(browse("").path, homedir(), "empty means home");
assert.throws(() => browse(join(root, "file.txt")), /not a directory/);

// Favourites: same shape as the project list, minus the seed.
const favoritesBefore = listFavorites();
assert.throws(() => addFavorite(join(root, "file.txt")), /not a directory/);
const pinned = addFavorite(root);
assert(pinned.includes(root), "pin");
assert.deepEqual(addFavorite(root), pinned, "pin is idempotent");
assert(!removeFavorite(`${root}/`).includes(root), "unpin normalises the path");
assert.deepEqual(listFavorites(), favoritesBefore, "restored");

rmSync(root, { recursive: true, force: true });
console.log("ok");
