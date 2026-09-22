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
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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

/** A session file whose mtime is `mtimeMs`, for the foreign-write check. */
function sessionFileAt(mtimeMs: number): string {
	const file = join(mkdtempSync(join(tmpdir(), "pwi-registry-")), "session.jsonl");
	writeFileSync(file, "");
	utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	return file;
}

/** An entry as `refreshIfForeignWrites` reads it, with a `restart` spy. */
function refreshCase(opts: { fileMtime: number; lastEventAt: number; streaming?: boolean }) {
	const calls: string[] = [];
	const entry = {
		error: null,
		streaming: opts.streaming ?? false,
		lastEventAt: opts.lastEventAt,
		session: { isStreaming: false, file: sessionFileAt(opts.fileMtime) },
	};
	const registry = registryWith("s", entry);
	// The real one spawns pi; here it only records that it was reached.
	(registry as unknown as { restart: (id: string) => Promise<void> }).restart = async (id) => {
		calls.push(id);
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
// refreshIfForeignWrites
//
// The message list comes from events THIS child emits, so a second pi writing
// the same session file is invisible: the server serves a transcript frozen
// at its own child's last word while the conversation continues on disk. A
// port takeover produces exactly that — it kills the old SERVER by pid and
// its pi children outlive it, still attached and still writing.
// ---------------------------------------------------------------------------

const now = Date.now();

test("a file written well after our last event reopens the session", async () => {
	const { registry, calls } = refreshCase({ fileMtime: now, lastEventAt: now - 600_000 });
	await registry.refreshIfForeignWrites("s");
	assert.deepEqual(calls, ["s"]);
});

test("our own child writing just after it emits does not", async () => {
	// The common case by far: persist lands a few ms past the event, and
	// reopening on that would restart the session after every turn.
	const { registry, calls } = refreshCase({ fileMtime: now, lastEventAt: now - 50 });
	await registry.refreshIfForeignWrites("s");
	assert.deepEqual(calls, []);
});

test("a file older than our last event does not", async () => {
	const { registry, calls } = refreshCase({ fileMtime: now - 600_000, lastEventAt: now });
	await registry.refreshIfForeignWrites("s");
	assert.deepEqual(calls, []);
});

test("a streaming session is never reopened under itself", async () => {
	// Mid-turn the writer is ours, and a reopen would lose the turn.
	const { registry, calls } = refreshCase({
		fileMtime: now,
		lastEventAt: now - 600_000,
		streaming: true,
	});
	await registry.refreshIfForeignWrites("s");
	assert.deepEqual(calls, []);
});

test("a missing file is left alone rather than thrown on", async () => {
	const { registry, calls } = refreshCase({ fileMtime: now, lastEventAt: now - 600_000 });
	const entry = (registry as unknown as { entries: Map<string, { session: { file: string } }> }).entries.get("s");
	if (entry) entry.session.file = "/nonexistent/session.jsonl";
	await registry.refreshIfForeignWrites("s");
	assert.deepEqual(calls, []);
});

test("an unknown id is a no-op", async () => {
	const { registry, calls } = refreshCase({ fileMtime: now, lastEventAt: now - 600_000 });
	await registry.refreshIfForeignWrites("nope");
	assert.deepEqual(calls, []);
});
