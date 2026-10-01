import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import setup from "./compaction-extension.js";

const dir = mkdtempSync(join(tmpdir(), "pwi-compaction-"));
process.env.PWI_STATE_DIR = dir;
type Handler = Parameters<Parameters<typeof setup>[0]["on"]>[1];
let handler: Handler | undefined;
setup({ on(event, fn) { assert.equal(event, "session_before_compact"); handler = fn; } });
const seen: string[] = [];
const errors: string[] = [];
const ctx = {
	modelRegistry: {
		find(provider: string, id: string) { seen.push(`${provider}/${id}`); return undefined; },
		streamSimple() { throw new Error("must not call another model on failure"); },
	},
	ui: { notify(message: string) { errors.push(message); } },
};
try {
	assert.ok(handler);
	const event = { preparation: { fileOps: { read: new Set<string>(), edited: new Set<string>() } }, signal: new AbortController().signal };
	assert.deepEqual(await handler(event, ctx), { cancel: true });
	assert.equal(seen.at(-1), "openai-codex/gpt-6.1-sol");
	assert.match(errors.at(-1)!, /unknown compaction model/);
	writeFileSync(join(dir, "automatic-models.json"), JSON.stringify({ compaction: "new-provider/summary" }));
	assert.deepEqual(await handler(event, ctx), { cancel: true });
	assert.equal(seen.at(-1), "new-provider/summary");
	writeFileSync(join(dir, "automatic-models.json"), "bad json");
	assert.deepEqual(await handler(event, ctx), { cancel: true });
	assert.match(errors.at(-1)!, /not a valid JSON object/);
	assert.equal(seen.length, 2);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
