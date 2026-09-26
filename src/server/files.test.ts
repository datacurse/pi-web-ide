// Run: node --import tsx src/server/files.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	copyEntry,
	createEntry,
	moveEntry,
	readFile,
	safePath,
	trashEntry,
	writeReviewed,
} from "./files.js";

const root = mkdtempSync(join(tmpdir(), "pwi-files-"));
const proj = join(root, "proj");
mkdirSync(proj);
writeFileSync(join(proj, "a.ts"), "hello\n");

// A sibling whose name SHARES A PREFIX with the project: the containment hole
// a `startsWith` check would walk straight into.
const sibling = `${proj}-secrets`;
mkdirSync(sibling);
writeFileSync(join(sibling, "keys.txt"), "secret\n");

try {
	// In-project paths resolve.
	assert.equal(safePath(proj, join(proj, "a.ts")), join(proj, "a.ts"));
	// Nested too.
	assert.equal(safePath(proj, join(proj, "x", "y.ts")), join(proj, "x", "y.ts"));

	// Traversal out of the project is refused, not clamped.
	assert.throws(() => safePath(proj, join(proj, "..", "..", "etc", "passwd")), /outside/);
	// The prefix-sibling is a DIFFERENT directory, whatever the string says.
	assert.throws(() => safePath(proj, join(sibling, "keys.txt")), /outside/);
	// An absolute path elsewhere on the box.
	assert.throws(() => safePath(proj, "/etc/passwd"), /outside/);
	// Empty is a bug in the caller, not an alias for the project root.
	assert.throws(() => safePath(proj, "  "), /path required/);

	// Reading.
	assert.equal(readFile(proj, join(proj, "a.ts")), "hello\n");
	// Absent is null, not a throw: the pane must render a deleted file.
	assert.equal(readFile(proj, join(proj, "gone.ts")), null);
	// A directory is not a file.
	assert.throws(() => readFile(proj, proj), /not a file/);

	// Writing only when the caller's idea of disk still matches.
	writeReviewed(proj, join(proj, "a.ts"), "hello\n", "bye\n");
	assert.equal(readFileSync(join(proj, "a.ts"), "utf8"), "bye\n");

	// Stale expectation refuses rather than clobbering what landed in between.
	assert.throws(() => writeReviewed(proj, join(proj, "a.ts"), "hello\n", "other\n"), /changed on disk/);
	assert.equal(readFileSync(join(proj, "a.ts"), "utf8"), "bye\n");

	// And the boundary holds on the write path too.
	assert.throws(() => writeReviewed(proj, join(sibling, "keys.txt"), "secret\n", "owned\n"), /outside/);
	assert.equal(readFileSync(join(sibling, "keys.txt"), "utf8"), "secret\n");

	// Create: files and folders, missing parents made, never over an existing one.
	createEntry(proj, join(proj, "new", "deep.ts"), false);
	assert.equal(readFileSync(join(proj, "new", "deep.ts"), "utf8"), "");
	createEntry(proj, join(proj, "folder"), true);
	assert.throws(() => createEntry(proj, join(proj, "a.ts"), false), /already exists/);
	assert.equal(readFileSync(join(proj, "a.ts"), "utf8"), "bye\n");
	assert.throws(() => createEntry(proj, join(sibling, "x.ts"), false), /outside/);

	// Move: refuses an existing target, its own subtree, the project root, and escapes.
	moveEntry(proj, join(proj, "new", "deep.ts"), join(proj, "folder", "deep.ts"));
	assert.ok(existsSync(join(proj, "folder", "deep.ts")));
	assert.throws(() => moveEntry(proj, join(proj, "folder", "deep.ts"), join(proj, "a.ts")), /already exists/);
	assert.throws(() => moveEntry(proj, join(proj, "folder"), join(proj, "folder", "in")), /into itself/);
	assert.throws(() => moveEntry(proj, proj, join(proj, "x")), /project root/);
	assert.throws(() => moveEntry(proj, join(proj, "a.ts"), join(sibling, "a.ts")), /outside/);
	assert.throws(() => moveEntry(proj, join(proj, "gone.ts"), join(proj, "b.ts")), /no such file/);

	// Copy: a free name when the source's is taken, never into itself.
	assert.equal(copyEntry(proj, join(proj, "a.ts"), proj), join(proj, "a copy.ts"));
	assert.equal(copyEntry(proj, join(proj, "a.ts"), proj), join(proj, "a copy 2.ts"));
	assert.equal(copyEntry(proj, join(proj, "folder"), join(proj, "new")), join(proj, "new", "folder"));
	assert.ok(existsSync(join(proj, "new", "folder", "deep.ts")));
	assert.throws(() => copyEntry(proj, join(proj, "folder"), join(proj, "folder")), /into itself/);

	// Trash: into the desktop Trash with an info file, never unlinked outright.
	const data = join(root, "data");
	const before = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = data;
	try {
		trashEntry(proj, join(proj, "a copy.ts"));
		assert.equal(existsSync(join(proj, "a copy.ts")), false);
		assert.equal(readFileSync(join(data, "Trash", "files", "a copy.ts"), "utf8"), "bye\n");
		assert.match(
			readFileSync(join(data, "Trash", "info", "a copy.ts.trashinfo"), "utf8"),
			/^\[Trash Info\]\nPath=.*a%20copy\.ts\nDeletionDate=/,
		);
		// A second item with the same name does not replace the first.
		writeFileSync(join(proj, "a copy.ts"), "again\n");
		trashEntry(proj, join(proj, "a copy.ts"));
		assert.equal(readFileSync(join(data, "Trash", "files", "a copy trashed.ts"), "utf8"), "again\n");
		assert.throws(() => trashEntry(proj, proj), /project root/);
		assert.throws(() => trashEntry(proj, join(sibling, "keys.txt")), /outside/);
		assert.ok(existsSync(join(sibling, "keys.txt")));
	} finally {
		if (before === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = before;
	}

	console.log("files: ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
