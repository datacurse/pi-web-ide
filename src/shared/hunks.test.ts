// Run: node --import tsx src/shared/hunks.test.ts
import assert from "node:assert/strict";
import {
	fitHunk,
	hashContent,
	hunkFromWrite,
	hunksFromEdit,
	resolve,
	revertHunks,
	type Hunk,
} from "./hunks.js";

const BEFORE = ["import a from 'a';", "", "function go() {", "\treturn 1;", "}", ""].join("\n");

// One edit call, one hunk, anchored where the text actually was.
const [h] = hunksFromEdit("call-1", "/x/y.ts", BEFORE, [
	{ oldText: "return 1;", newText: "return 2;" },
]);
assert.equal(h.id, "call-1:0");
assert.equal(h.state, "pending");
assert.equal(h.anchor.line, 3);
assert.equal(h.baseHash, hashContent(BEFORE));
// Context is lines around the change, not the change itself.
assert.ok(h.anchor.before.includes("function go()"));
assert.ok(h.anchor.after.includes("}"));

// Ids are positional, so replaying the same tool call yields the same ids —
// this is what lets a reloaded transcript find its stored decisions.
const again = hunksFromEdit("call-1", "/x/y.ts", BEFORE, [
	{ oldText: "return 1;", newText: "return 2;" },
]);
assert.equal(again[0].id, h.id);

// An oldText that is not in the file is DROPPED, never anchored at 0: a hunk
// that cannot be placed must never be reverted.
assert.equal(hunksFromEdit("c", "/x/y.ts", BEFORE, [{ oldText: "nope", newText: "x" }]).length, 0);

// The edit is already on disk, so "current" contains newText.
const AFTER = BEFORE.replace("return 1;", "return 2;");

// Accepted means "keep": resolve() must not touch a single byte.
assert.equal(resolve(AFTER, [{ ...h, state: "accepted" }]), AFTER);
// Pending is also a no-op — an undecided hunk stays as the agent left it.
assert.equal(resolve(AFTER, [h]), AFTER);
// Rejected is the only state that writes, and it puts oldText back.
assert.equal(resolve(AFTER, [{ ...h, state: "rejected" }]), BEFORE);

// Offsets shifted by an unrelated edit above the hunk: relocation must still
// find it. This is the case character offsets get wrong.
const SHIFTED = `// a new first line\n// and another\n${AFTER}`;
const fit = fitHunk(h, SHIFTED);
assert.equal(fit.fit, "unique");
assert.equal(SHIFTED.slice(fit.from, fit.to), "return 2;");
assert.equal(resolve(SHIFTED, [{ ...h, state: "rejected" }]), `// a new first line\n// and another\n${BEFORE}`);

// Already reverted by hand: nothing to find, and a forced write would corrupt.
assert.deepEqual(fitHunk(h, BEFORE), { fit: "missing" });
assert.equal(resolve(BEFORE, [{ ...h, state: "rejected" }]), BEFORE);

// Identical text in two places is reported, not silently resolved — and the
// line hint picks the nearer one.
const DUP = ["\treturn 2;", "x", "y", "z", "\treturn 2;"].join("\n");
const dupHunk: Hunk = { ...h, anchor: { ...h.anchor, line: 4 } };
const amb = fitHunk(dupHunk, DUP);
if (amb.fit !== "ambiguous") throw new Error(`expected ambiguous, got ${amb.fit}`);
assert.equal(amb.count, 2);
// line 4 is the second occurrence, so that is the one chosen.
assert.equal(DUP.slice(0, amb.from).split("\n").length - 1, 4);

// Multiple hunks revert back-to-front: doing it forwards invalidates the
// offsets of the ones not yet done.
const multi = hunksFromEdit("c2", "/x/y.ts", BEFORE, [
	{ oldText: "import a from 'a';", newText: "import b from 'b';" },
	{ oldText: "return 1;", newText: "return 2;" },
]);
assert.equal(multi.length, 2);
const bothApplied = BEFORE.replace("import a from 'a';", "import b from 'b';").replace(
	"return 1;",
	"return 2;",
);
assert.equal(revertHunks(bothApplied, multi), BEFORE);
// Rejecting only one leaves the other exactly as the agent wrote it.
assert.equal(
	resolve(bothApplied, [{ ...multi[0], state: "rejected" }, { ...multi[1], state: "accepted" }]),
	BEFORE.replace("return 1;", "return 2;"),
);

// A created file carries baseHash null — "did not exist" reverts by deleting,
// "existed empty" by truncating, and the pane must be able to tell them apart.
const created = hunkFromWrite("c3", "/x/new.ts", null, "hello\n");
assert.equal(created.baseHash, null);
assert.equal(created.oldText, "");
const overwritten = hunkFromWrite("c4", "/x/old.ts", "old\n", "new\n");
assert.equal(overwritten.baseHash, hashContent("old\n"));
assert.equal(resolve("new\n", [{ ...overwritten, state: "rejected" }]), "old\n");

// A deletion leaves no newText to search for; the anchor is what locates it.
const [del] = hunksFromEdit("c5", "/x/y.ts", BEFORE, [{ oldText: "\treturn 1;\n", newText: "" }]);
const deleted = BEFORE.replace("\treturn 1;\n", "");
assert.equal(resolve(deleted, [{ ...del, state: "rejected" }]), BEFORE);

console.log("hunks: ok");
