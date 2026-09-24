// Run: node --import tsx src/web/sessionName.test.ts
import assert from "node:assert/strict";
import { sessionLabel, shortName } from "./sessionName.js";

// Precedence: a name always wins, and it wins in both modes.
const info = {
	name: "Fix the parser",
	firstMessage: "please fix the parser, it crashes on ...",
};
assert.equal(sessionLabel(info, false), "Fix the parser");
assert.equal(sessionLabel(info, true), "Fix the parser");

// No name: the first prompt, whole or shortened.
const unnamed = {
	firstMessage:
		"not a fan of opening directory like this. i would rather open it with some kind of folder explorer",
};
assert.equal(
	sessionLabel(unnamed, false),
	"not a fan of opening directory like this. i would rather ope",
	"long mode is the first line, capped at 60",
);
assert.equal(
	sessionLabel(unnamed, true),
	"Not a fan of opening directory like this",
	"short mode is the opening clause, at most eight words",
);

// Neither: a placeholder, not eight characters of uuid — a fresh tab says what
// it is, and a hex id says nothing at all.
assert.equal(sessionLabel({ firstMessage: "  " }, true), "New session");
assert.equal(sessionLabel(undefined, false), "New session");

// A whole short sentence keeps its words but loses the punctuation it was cut on.
assert.equal(shortName("do you have caveman mode on?"), "Do you have caveman mode on");
assert.equal(shortName("fix the parser, and then run the tests"), "Fix the parser");
// …but only before a conjunction. Neither of these has its subject before the
// comma, and cutting there would name the session "Hey" or "Tell me please".
assert.equal(shortName("hey, can you fix the parser"), "Hey, can you fix the parser");
assert.equal(
	shortName("tell me please, do i have code for converting 3ga to text"),
	"Tell me please, do i have code for",
);
// Newlines are a line break in a prompt, not a word boundary to keep.
assert.equal(shortName("rename this\nand that"), "Rename this and that");
// The character ceiling bites before the word ceiling on long tokens: this one
// fits at 47 characters, one more flag character and it does not.
assert.equal(
	shortName("add --enable-experimental-web-platform-features to it"),
	"Add --enable-experimental-web-platform-features",
);
assert.equal(shortName(`add --${"x".repeat(44)} to it`), "Add");
// A single word past the ceiling is still that word, truncated rather than dropped.
assert.equal(shortName("x".repeat(60)), "X".padEnd(48, "x"));
// Nothing in, nothing out: the caller falls back to the placeholder.
assert.equal(shortName("   "), "");

console.log("ok");
