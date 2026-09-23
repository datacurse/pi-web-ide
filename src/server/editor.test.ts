// Run: node --import tsx src/server/editor.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDir, writeFile } from "./files.js";

const root = mkdtempSync(join(tmpdir(), "pwi-editor-"));
const proj = join(root, "proj");
mkdirSync(proj);
mkdirSync(join(proj, "src"));
mkdirSync(join(proj, "node_modules"));
writeFileSync(join(proj, "node_modules", "junk.js"), "x");
mkdirSync(join(proj, ".git"));
writeFileSync(join(proj, "a.ts"), "hello\n");
writeFileSync(join(proj, ".env"), "SECRET=1\n");

try {
	const entries = listDir(proj, proj);
	const names = entries.map((e) => e.name);
	// Directories sort before files; dotted names last within each group.
	assert.deepEqual(names, ["src", "a.ts", ".env"]);
	// node_modules and .git are skipped at the directory level, not filtered
	// out of results — expanding them is the cost this avoids.
	assert.ok(!names.includes("node_modules"));
	assert.ok(!names.includes(".git"));
	assert.equal(entries.find((e) => e.name === "src")?.dir, true);
	assert.equal(entries.find((e) => e.name === "a.ts")?.dir, false);
	assert.equal(entries.find((e) => e.name === ".env")?.hidden, true);

	// Listing is contained the same way reads and writes are.
	assert.throws(() => listDir(proj, "/etc"), /outside/);

	// A save whose base still matches disk succeeds.
	writeFile(proj, join(proj, "a.ts"), "hello\n", "goodbye\n");
	assert.equal(readFileSync(join(proj, "a.ts"), "utf8"), "goodbye\n");

	// THE CASE THIS EXISTS FOR: the agent wrote while the tab was open. The
	// editor still holds the old base, and the save must be refused rather
	// than silently discarding the agent's write.
	writeFileSync(join(proj, "a.ts"), "written by the agent\n");
	assert.throws(
		() => writeFile(proj, join(proj, "a.ts"), "goodbye\n", "user edit\n"),
		/changed on disk/,
	);
	assert.equal(readFileSync(join(proj, "a.ts"), "utf8"), "written by the agent\n");

	// Re-basing on what is actually there lets the save through — this is what
	// the UI's Reload button does.
	writeFile(proj, join(proj, "a.ts"), "written by the agent\n", "user edit\n");
	assert.equal(readFileSync(join(proj, "a.ts"), "utf8"), "user edit\n");

	// A new file expects absence, which `expect: ""` says.
	writeFile(proj, join(proj, "src", "new.ts"), "", "fresh\n");
	assert.equal(readFileSync(join(proj, "src", "new.ts"), "utf8"), "fresh\n");
	// And creating over something that already exists is a conflict.
	assert.throws(() => writeFile(proj, join(proj, "src", "new.ts"), "", "again\n"), /changed on disk/);

	// Writes are contained too.
	assert.throws(() => writeFile(proj, "/tmp/escape.ts", "", "x"), /outside/);

	console.log("editor: ok");
} finally {
	rmSync(root, { recursive: true, force: true });
}
