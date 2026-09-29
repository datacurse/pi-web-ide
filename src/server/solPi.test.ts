// Run: node --import tsx src/server/solPi.test.ts
//
// SoL-Pi refuses to load on an unknown key or a wrong type, so what this
// writes must stay inside its schema, and a file it cannot read is never replaced.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSolPi, writeSolPi } from "./solPi.js";

const dir = mkdtempSync(join(tmpdir(), "pwi-solpi-"));
process.env.PI_CODING_AGENT_DIR = dir;
const file = join(dir, "sol-pi.json");
const onDisk = () => JSON.parse(readFileSync(file, "utf8"));

// Absent: every mechanism off, no file claimed.
assert.deepEqual(readSolPi(dir).config, {
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	onlineContextCompact: false,
});
assert.equal(readSolPi(dir).exists, false);
// The project's own file is reported, since it replaces this one.
assert.equal(readSolPi(dir).projectFile, null);

// A change merges into what is there and stamps the version.
writeFileSync(file, JSON.stringify({ version: 1, observationPack: true, cacheWriteReadRatio: 3 }));
writeSolPi({ actionFusion: true }, dir);
assert.deepEqual(onDisk(), { version: 1, observationPack: true, cacheWriteReadRatio: 3, actionFusion: true });

// Empty route fields and a null ratio remove their keys, back to SoL-Pi's defaults.
writeSolPi({ evidencePreservingReducerModel: " m ", evidencePreservingReducerProvider: "p" }, dir);
writeSolPi({ evidencePreservingReducerProvider: "", cacheWriteReadRatio: null }, dir);
assert.deepEqual(onDisk(), { version: 1, observationPack: true, actionFusion: true, evidencePreservingReducerModel: "m" });

// Refusals, and the file is left as it was.
const before = readFileSync(file, "utf8");
assert.throws(() => writeSolPi({ actionFusion: "yes" }, dir), /boolean/);
assert.throws(() => writeSolPi({ cacheWriteReadRatio: -1 }, dir), /non-negative/);
assert.throws(() => writeSolPi({ version: 2 }, dir), /unknown setting/);
assert.equal(readFileSync(file, "utf8"), before);

writeFileSync(file, "{ not json");
assert.throws(() => writeSolPi({ actionFusion: true }, dir), /not valid JSON/);
assert.equal(readFileSync(file, "utf8"), "{ not json");
