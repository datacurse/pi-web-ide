import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { automaticModel, autoCompactionEnabled } from "./automaticModelConfig.js";
import { automaticModels, setAutomaticModel, setAutoCompaction } from "./automaticModels.js";
import { ensureSolPiReducer, readSolPi, writeSolPi } from "./solPi.js";
import { DEFAULT_AUTOMATIC_MODEL } from "../shared/automaticModels.js";

const dir = mkdtempSync(join(tmpdir(), "pwi-automatic-models-"));
process.env.PWI_STATE_DIR = dir;
process.env.PI_CODING_AGENT_DIR = dir;
delete process.env.PWI_NAMING_MODEL;
try {
	assert.equal(autoCompactionEnabled(), false);
	assert.deepEqual(automaticModels(dir), {
		commitNaming: DEFAULT_AUTOMATIC_MODEL,
		sessionNaming: DEFAULT_AUTOMATIC_MODEL,
		compaction: DEFAULT_AUTOMATIC_MODEL,
		reducer: DEFAULT_AUTOMATIC_MODEL,
	});
	process.env.PWI_NAMING_MODEL = "custom/naming";
	assert.equal(automaticModel("commitNaming"), "custom/naming");
	assert.equal(automaticModel("compaction"), DEFAULT_AUTOMATIC_MODEL);
	const file = join(dir, "automatic-models.json");
	writeFileSync(file, JSON.stringify({ commitNaming: "custom/commit", sessionNaming: "custom/title", compaction: "custom/compact" }));
	assert.equal(automaticModel("commitNaming"), "custom/commit");
	assert.equal(automaticModel("sessionNaming"), "custom/title");
	assert.equal(automaticModel("compaction"), "custom/compact");
	assert.equal(autoCompactionEnabled(), false);
	setAutoCompaction(true);
	assert.equal(autoCompactionEnabled(), true);
	assert.equal(automaticModel("compaction"), "custom/compact");
	setAutoCompaction(false);
	assert.equal(autoCompactionEnabled(), false);
	const saved = readFileSync(file, "utf8");
	assert.throws(() => setAutoCompaction("true"), /must be a boolean/);
	assert.equal(readFileSync(file, "utf8"), saved);
	writeFileSync(file, JSON.stringify({ autoCompaction: "true" }));
	assert.equal(autoCompactionEnabled(), false);
	await assert.rejects(setAutomaticModel("bogus", DEFAULT_AUTOMATIC_MODEL, dir), /unknown automatic action/);
	await assert.rejects(setAutomaticModel("compaction", null, dir), /unknown model/);
	writeFileSync(file, "bad json");
	assert.throws(() => automaticModel("compaction"), /not a valid JSON object/);
	assert.throws(() => setAutoCompaction(true), /not a valid JSON object/);
	assert.equal(readFileSync(file, "utf8"), "bad json");
	writeSolPi({ evidencePreservingReducer: true }, dir);
	assert.equal(readSolPi(dir).config.evidencePreservingReducerModel, "gpt-6.1-sol");
	assert.equal(readSolPi(dir).config.evidencePreservingReducerProvider, "openai-codex");
	writeSolPi({ evidencePreservingReducerProvider: "custom", evidencePreservingReducerModel: "log" }, dir);
	ensureSolPiReducer();
	assert.equal(readSolPi(dir).config.evidencePreservingReducerModel, "log");
	writeFileSync(join(dir, "sol-pi.json"), JSON.stringify({ version: 1, evidencePreservingReducer: true, observationPack: true }));
	ensureSolPiReducer();
	assert.equal(readSolPi(dir).config.evidencePreservingReducerModel, "gpt-6.1-sol");
	assert.equal(readSolPi(dir).config.observationPack, true);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
