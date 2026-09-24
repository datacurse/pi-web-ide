// Run: node --import tsx src/server/personality.test.ts
//
// PWI_STATE_DIR is pointed at a temp dir before the first call, because the
// real file is the user's live personality text and a test must never be the
// thing that rewrites it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	personalityPath,
	readPersonality,
	readRemind,
	writePersonality,
	writeRemind,
} from "./personality.js";

const dir = mkdtempSync(join(tmpdir(), "pwi-personality-"));
process.env.PWI_STATE_DIR = dir;
const path = join(dir, "personality.md");

// The path agent.ts passes to `--append-system-prompt` and the path the
// dialog edits have to be the same file, or the box writes somewhere nothing
// reads.
assert.equal(personalityPath(), path);

// Absent is reported, not thrown: that is the state of a machine that never
// set one, and the field has to open on it.
const missing = readPersonality();
assert.equal(missing.exists, false);
assert.equal(missing.content, "");
assert.equal(missing.path, path);

// Content is written verbatim apart from a trailing newline, and read back
// byte for byte — no normalisation, no template.
const text = "Answer in haiku.\n\n- Keep  double  spaces\n- Keep *markdown*";
const written = writePersonality(text);
assert.equal(written.content, `${text}\n`, "trailing newline added, nothing else");
assert.equal(readFileSync(path, "utf8"), `${text}\n`);
assert.deepEqual(readPersonality(), {
	path,
	content: `${text}\n`,
	exists: true,
	remind: false,
});

// The toggle defaults off, persists, and does not touch the text.
assert.equal(readRemind(), false);
assert.equal(writeRemind(true).remind, true);
assert.equal(readPersonality().content, `${text}\n`);
assert.equal(writeRemind(false).remind, false);

// An already-terminated file is not given a second newline on every save.
assert.equal(writePersonality(`${text}\n`).content, `${text}\n`, "idempotent");

// Empty is a legitimate save: agent.ts skips a zero-byte file, so clearing
// the box is how the override is turned off.
assert.equal(writePersonality("").content, "");
assert.equal(readFileSync(path, "utf8"), "");

// The cap is what stops a paste accident entering every future system prompt,
// and a rejected write must leave the existing file alone.
writePersonality("keep me");
assert.throws(() => writePersonality("x".repeat(256 * 1024 + 1)), /too large/);
assert.equal(readFileSync(path, "utf8"), "keep me\n", "rejected write changed nothing");

// A file written by hand is what the next read reports: there is no cached
// copy anywhere.
writeFileSync(path, "edited in $EDITOR\n");
assert.equal(readPersonality().content, "edited in $EDITOR\n");

console.log("ok");
