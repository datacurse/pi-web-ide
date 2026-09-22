// Run: node --import tsx src/server/registry.test.ts
//
// `clearDeadError` only, which is the escape from a trap that cost a real
// session: `error` used to be cleared by the next prompt alone, so an error
// that stopped you prompting re-served itself on every reload. It outlives
// the process that caused it, because the entry is rebuilt from the session
// file while the string is not.
//
// The registry needs a live pi to construct, so these drive the method
// against the entry shape it actually touches rather than a spawned child.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Registry } from "./registry.js";

/** The three fields `clearDeadError` reads, and nothing else. */
function fakeEntry(error: string | null, streaming: boolean, sessionStreaming = false) {
	return { error, streaming, session: { isStreaming: sessionStreaming } };
}

/** A registry with `entries` populated directly: no child process involved. */
function registryWith(id: string, entry: ReturnType<typeof fakeEntry>): Registry {
	const registry = Object.create(Registry.prototype) as Registry;
	(registry as unknown as { entries: Map<string, unknown> }).entries = new Map([[id, entry]]);
	return registry;
}

test("an error from a settled turn is cleared", () => {
	const entry = fakeEntry("Anthropic API error 400: tool_use ids were found without", false);
	registryWith("s1", entry).clearDeadError("s1");
	assert.equal(entry.error, null);
});

test("an error is kept while the entry is streaming", () => {
	// Here the error IS the live state of the turn on screen; clearing it
	// would hide a failure as it happens.
	const entry = fakeEntry("boom", true);
	registryWith("s2", entry).clearDeadError("s2");
	assert.equal(entry.error, "boom");
});

test("an error is kept while the underlying session is streaming", () => {
	// `streaming` is the registry's own flag and `session.isStreaming` is pi's;
	// they disagree around the edges of a turn, so both are checked.
	const entry = fakeEntry("boom", false, true);
	registryWith("s3", entry).clearDeadError("s3");
	assert.equal(entry.error, "boom");
});

test("an unknown id is a no-op, not a throw", () => {
	// Both callers are HTTP routes that have already 404'd on a missing entry;
	// this must not become a second way for them to fail.
	const registry = registryWith("s4", fakeEntry(null, false));
	assert.doesNotThrow(() => registry.clearDeadError("nope"));
});

test("clearing twice is harmless", () => {
	// The snapshot route and the events route both call this on one reload.
	const entry = fakeEntry("stale", false);
	const registry = registryWith("s5", entry);
	registry.clearDeadError("s5");
	registry.clearDeadError("s5");
	assert.equal(entry.error, null);
});
