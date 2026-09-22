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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Registry } from "./registry.js";

/** The three fields `clearDeadError` reads, and nothing else. */
function fakeEntry(error: string | null, streaming: boolean, sessionStreaming = false) {
	return { error, streaming, session: { isStreaming: sessionStreaming } };
}

/** A registry with `entries` populated directly: no child process involved. */
function registryWith(id: string, entry: unknown): Registry {
	const registry = Object.create(Registry.prototype) as Registry;
	(registry as unknown as { entries: Map<string, unknown> }).entries = new Map([[id, entry]]);
	return registry;
}

/** A session file whose last `message` entry is stamped `at`. */
function sessionFile(at: number): string {
	const file = join(mkdtempSync(join(tmpdir(), "pwi-registry-")), "session.jsonl");
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", id: "s", cwd: "/tmp" })}\n${JSON.stringify({
			type: "message",
			timestamp: new Date(at).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
		})}\n`,
	);
	return file;
}

/**
 * An entry as `refreshIfFileIsAhead` reads it.
 *
 * `restart` is not a no-op spy: it advances the entry's newest message to the
 * file's, which is what a real reopen does. That is the whole point — a spy
 * that records and changes nothing cannot tell a fix from an infinite loop,
 * and the previous attempt at this feature shipped a per-read spawn loop
 * precisely because its test mocked the convergence away.
 */
function refreshCase(opts: { fileAt: number; oursAt: number; streaming?: boolean }) {
	const calls: string[] = [];
	const file = sessionFile(opts.fileAt);
	let newest = opts.oursAt;
	const entry = {
		error: null,
		streaming: opts.streaming ?? false,
		session: {
			isStreaming: false,
			file,
			messages: () => (newest ? [{ role: "assistant", blocks: [], timestamp: newest }] : []),
		},
	};
	const registry = registryWith("s", entry);
	(registry as unknown as { restart: (id: string) => Promise<void> }).restart = async (id) => {
		calls.push(id);
		newest = opts.fileAt; // reopening reads the file, so we now hold its newest
	};
	return { registry, calls };
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

// ---------------------------------------------------------------------------
// refreshIfFileIsAhead
//
// A session is the FILE; a child is one reader of it. Two pi processes can
// hold the same session — a port takeover orphans a child that keeps writing,
// and an agent started elsewhere in the same cwd derives the same file — so
// the transcript freezes at our child's last word while the file grows.
// ---------------------------------------------------------------------------

const now = Date.now();

test("a file newer than our newest message reopens the session", async () => {
	const { registry, calls } = refreshCase({ fileAt: now, oursAt: now - 600_000 });
	await registry.refreshIfFileIsAhead("s");
	assert.deepEqual(calls, ["s"]);
});

test("reopening converges: a second read does not reopen again", async () => {
	// The property the mtime version lacked. A live foreign writer keeps mtime
	// permanently ahead, so that comparison reopened on EVERY read and spawned
	// a pi child per request; comparing messages stops as soon as we hold what
	// the file holds.
	const { registry, calls } = refreshCase({ fileAt: now, oursAt: now - 600_000 });
	for (let i = 0; i < 5; i++) await registry.refreshIfFileIsAhead("s");
	assert.deepEqual(calls, ["s"], "must reopen once, not once per read");
});

test("our own last message matching the file does not reopen", async () => {
	const { registry, calls } = refreshCase({ fileAt: now, oursAt: now });
	await registry.refreshIfFileIsAhead("s");
	assert.deepEqual(calls, []);
});

test("a write landing a moment after our stamp is within the margin", async () => {
	// Our child stamps, then the line reaches disk; that gap is not a foreign
	// writer, and reopening on it would restart the session every turn.
	const { registry, calls } = refreshCase({ fileAt: now + 400, oursAt: now });
	await registry.refreshIfFileIsAhead("s");
	assert.deepEqual(calls, []);
});

test("a streaming session is never reopened under itself", async () => {
	const { registry, calls } = refreshCase({
		fileAt: now,
		oursAt: now - 600_000,
		streaming: true,
	});
	await registry.refreshIfFileIsAhead("s");
	assert.deepEqual(calls, []);
});

test("an empty message list is not treated as evidence", async () => {
	// A freshly opened session legitimately has no messages yet and a file
	// full of history; reopening there would loop on every read.
	const { registry, calls } = refreshCase({ fileAt: now, oursAt: 0 });
	await registry.refreshIfFileIsAhead("s");
	assert.deepEqual(calls, []);
});

test("an unreadable file is left alone rather than thrown on", async () => {
	const { registry, calls } = refreshCase({ fileAt: now, oursAt: now - 600_000 });
	const entries = (registry as unknown as { entries: Map<string, { session: { file: string } }> })
		.entries;
	const entry = entries.get("s");
	if (entry) entry.session.file = "/nonexistent/session.jsonl";
	await registry.refreshIfFileIsAhead("s");
	assert.deepEqual(calls, []);
});

test("an unknown id is a no-op", async () => {
	const { registry, calls } = refreshCase({ fileAt: now, oursAt: now - 600_000 });
	await registry.refreshIfFileIsAhead("nope");
	assert.deepEqual(calls, []);
});
