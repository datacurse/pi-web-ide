// Run: node --import tsx src/server/files.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, safePath, writeReviewed } from "./files.js";

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

	console.log("files: ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
