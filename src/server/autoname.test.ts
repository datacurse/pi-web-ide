// Run: node --import tsx src/server/autoname.test.ts
//
// `subjectAndBody` only: the rest of this module spawns a real pi, but the
// parse is where a model's reply becomes a git message, and the shapes below
// are the ones that actually come back — a bare subject, a subject with a
// body, and a reply with leading blank lines.
import assert from "node:assert/strict";
import { subjectAndBody } from "./autoname.js";

// No body: stays one line, no trailing blank lines for git to complain about.
assert.equal(subjectAndBody("Fix icon 404 after reinstall\n"), "Fix icon 404 after reinstall");

// Subject plus body: the blank line between them is the part git cares about.
assert.equal(
	subjectAndBody("Fix icon 404\n\n- sync-icons no longer rm -rf\n- Vite caches the listing\n"),
	"Fix icon 404\n\n- sync-icons no longer rm -rf\n- Vite caches the listing",
);

// Leading blank lines and a quoted subject, both of which models emit.
assert.equal(subjectAndBody('\n\n"Add language-data"\n\nWhy: every file type.'), "Add language-data\n\nWhy: every file type.");

// Nothing usable is an empty string, which the caller turns into an error.
assert.equal(subjectAndBody("\n \n"), "");

console.log("autoname ok");
