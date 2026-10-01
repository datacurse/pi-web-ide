import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "./registry.js";

function fixture(streaming = false, sessionStreaming = false, legacy = false) {
	const calls: boolean[] = [];
	const entry = {
		streaming, lastActivity: 0,
		session: { isStreaming: sessionStreaming, setFastMode: legacy ? undefined : async (enabled: boolean) => { calls.push(enabled); } },
	};
	const registry = Object.create(Registry.prototype) as Registry;
	(registry as unknown as { entries: Map<string, unknown> }).entries = new Map([["s", entry]]);
	return { registry, entry, calls };
}

test("Fast updates only the requested idle session", async () => {
	const f = fixture();
	await f.registry.setFastMode("s", true);
	await f.registry.setFastMode("s", false);
	assert.deepEqual(f.calls, [true, false]);
	assert.ok(f.entry.lastActivity > 0);
	await assert.rejects(f.registry.setFastMode("missing", true), /unknown session/);
});

test("Fast cannot change while either streaming flag is active", async () => {
	for (const [streaming, sessionStreaming] of [[true, false], [false, true]]) {
		const f = fixture(streaming, sessionStreaming);
		await assert.rejects(f.registry.setFastMode("s", true), /streaming/);
		assert.deepEqual(f.calls, []);
	}
});

test("legacy children fail safely instead of prompting the model", async () => {
	const f = fixture(false, false, true);
	await assert.rejects(f.registry.setFastMode("s", true), /restart this session/);
	assert.deepEqual(f.calls, []);
});
