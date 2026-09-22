// Run: node --import tsx src/server/repair.test.ts
//
// The one file in this server that WRITES pi's store, so the tests that
// matter are the ones about not damaging it: a file that does not need the
// pass must come back byte-for-byte identical, and a half-written final line
// (pi appends live) must survive a repair of the lines above it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repairSessionFile } from "./repair.js";

/** A session file in its own temp dir, since the repair writes a sibling temp. */
function sessionFile(lines: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "piw-repair-"));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, lines.join("\n"));
	return file;
}

const userTurn = (content: unknown) => JSON.stringify({ type: "message", message: { role: "user", content } });

test("image-only turn gets a caption instead of an empty text block", () => {
	const image = { type: "image", data: "abc", mimeType: "image/png" };
	const file = sessionFile([userTurn([{ type: "text", text: "" }, image]), ""]);

	assert.deepEqual(repairSessionFile(file), { captioned: 1, dropped: 0 });

	const content = JSON.parse(readFileSync(file, "utf8").split("\n")[0]).message.content;
	// Caption first: pi builds every turn text-first, and a caption after the
	// image it captions reads as a reply to it.
	assert.deepEqual(content, [{ type: "text", text: "(see attached image)" }, image]);
});

test("a turn with neither text nor images is dropped, not emptied", () => {
	// A user turn cannot be empty on the wire either, so captioning it would
	// swap one 400 for another.
	const file = sessionFile([userTurn([{ type: "text", text: "" }]), userTurn([{ type: "text", text: "kept" }]), ""]);

	assert.deepEqual(repairSessionFile(file), { captioned: 0, dropped: 1 });

	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]).message.content[0].text, "kept");
});

test("a clean file is left byte-for-byte alone", () => {
	const original = [userTurn([{ type: "text", text: "hello" }]), ""].join("\n");
	const file = sessionFile([original]);

	assert.deepEqual(repairSessionFile(file), { captioned: 0, dropped: 0 });
	assert.equal(readFileSync(file, "utf8"), original);
});

test("whitespace-only text counts as empty", () => {
	// The provider filters on `.trim()`, so " " is rejected exactly like "".
	const image = { type: "image", data: "abc", mimeType: "image/png" };
	const file = sessionFile([JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "   " }, image] } }), ""]);

	assert.deepEqual(repairSessionFile(file), { captioned: 1, dropped: 0 });
});

test("assistant turns and non-message entries are never touched", () => {
	// Rewriting a signed thinking block would invalidate a signature the API
	// verifies, and providers skip blank assistant text anyway.
	const assistant = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "" }] } });
	const header = JSON.stringify({ type: "session", cwd: "/tmp", text: "" });
	const file = sessionFile([header, assistant, ""]);

	assert.deepEqual(repairSessionFile(file), { captioned: 0, dropped: 0 });
	assert.equal(readFileSync(file, "utf8"), [header, assistant, ""].join("\n"));
});

test("a torn final line survives a repair of the lines above it", () => {
	// pi appends live, so the last line of an active session is regularly
	// half-written JSON. It must be copied through, not dropped as unparseable.
	const torn = '{"type":"message","message":{"role":"user","cont';
	const image = { type: "image", data: "abc", mimeType: "image/png" };
	const file = sessionFile([userTurn([{ type: "text", text: "" }, image]), torn]);

	assert.deepEqual(repairSessionFile(file), { captioned: 1, dropped: 0 });

	const lines = readFileSync(file, "utf8").split("\n");
	assert.equal(lines[1], torn);
});

test("no temp file is left behind in pi's store", () => {
	const image = { type: "image", data: "abc", mimeType: "image/png" };
	const file = sessionFile([userTurn([{ type: "text", text: "" }, image]), ""]);
	repairSessionFile(file);

	const stray = readdirSync(join(file, "..")).filter((f) => f.includes("piw-repair"));
	assert.deepEqual(stray, []);
});

test("an unreadable file is reported clean rather than thrown", () => {
	// The open path reports a missing session with the path in it; guessing
	// here would replace that message with a worse one.
	assert.deepEqual(repairSessionFile("/nonexistent/session.jsonl"), { captioned: 0, dropped: 0 });
});
