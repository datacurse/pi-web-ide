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
// Every list is written under PWI_STATE_DIR, so the test gets its own and
// never rewrites the developer's real project list.
process.env.PWI_STATE_DIR = mkdtempSync(join(tmpdir(), "pwi-projects-"));
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
const root = mkdtempSync(join(tmpdir(), "pwi-browse-"));
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

/*
 * The one-time inheritance from the previous install. A fresh state
 * directory with no projects.json falls back to the old install's list —
 * they are just paths, and retyping a dozen project directories after the
 * cutover is a pointless tax. The first write lands in the new location and
 * the old file is never consulted again, which is what this asserts: it is a
 * FALLBACK, not a sync.
 */
const fresh = mkdtempSync(join(tmpdir(), "pwi-state-"));
process.env.PWI_STATE_DIR = fresh;
const legacyHome = mkdtempSync(join(tmpdir(), "pwi-home-"));
mkdirSync(join(legacyHome, ".omp", "agent"), { recursive: true });
writeFileSync(
	join(legacyHome, ".omp", "agent", "pwi-projects.json"),
	JSON.stringify(["/tmp"]),
);
const realHome = process.env.HOME;
process.env.HOME = legacyHome;
try {
	assert(listProjects(seed).includes("/tmp"), "inherits the old install's projects");
	// Any write makes the new file authoritative; the old one stops counting.
	addProject(seed, tmpdir());
	writeFileSync(join(legacyHome, ".omp", "agent", "pwi-projects.json"), JSON.stringify(["/etc"]));
	assert(!listProjects(seed).includes("/etc"), "the legacy file is not read again");
} finally {
	process.env.HOME = realHome;
	rmSync(legacyHome, { recursive: true, force: true });
	rmSync(fresh, { recursive: true, force: true });
}

rmSync(root, { recursive: true, force: true });
console.log("ok");
