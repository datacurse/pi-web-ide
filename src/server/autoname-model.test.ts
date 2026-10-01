import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pwi-naming-model-"));
const binary = join(dir, "fake-pi");
writeFileSync(binary, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--model" ]; then printf "%s\\n" "$2"; exit 0; fi\n shift\ndone\nexit 1\n', { mode: 0o700 });
process.env.PWI_STATE_DIR = dir;
process.env.PWI_PI_BIN = binary;
delete process.env.PWI_NAMING_MODEL;
const { nameCommit, nameSession } = await import("./autoname.js");
try {
	assert.equal(await nameSession(dir, "Test title"), "openai-codex/gpt-6.1-sol");
	execFileSync("git", ["init", "--quiet", dir]);
	writeFileSync(join(dir, "note.txt"), "Change\n");
	assert.equal(await nameCommit(dir), "openai-codex/gpt-6.1-sol");
	writeFileSync(join(dir, "automatic-models.json"), JSON.stringify({ commitNaming: "custom/commit", sessionNaming: "custom/title" }));
	assert.equal(await nameSession(dir, "Test title"), "custom/title");
	assert.equal(await nameCommit(dir), "custom/commit");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
