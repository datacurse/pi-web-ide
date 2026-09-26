// Run: node --import tsx src/web/tabs.test.ts
import assert from "node:assert/strict";
import {
	afterPathChange,
	diffParts,
	diffTab,
	fileTab,
	groupOf,
	isDiffTab,
	isFileTab,
	isSessionTab,
	moveTab,
	pinnedFirst,
	tabLabel,
	tabPath,
	collapse,
	sideOfTab,
	withGroup,
	withoutTab,
	withTab,
} from "./tabs.js";
import { halfOf } from "./SplitZone.js";
import { slotFor } from "./SessionTabs.js";

// A file entry round-trips.
const t = fileTab("/home/me/proj/src/App.tsx");
assert.equal(isFileTab(t), true);
assert.equal(tabPath(t), "/home/me/proj/src/App.tsx");
assert.equal(tabLabel(t), "App.tsx");

// THE case the prefix exists for: a session entry is an absolute path to a
// .jsonl, and must never be mistaken for a file tab — App attaches to one and
// renders the other, so a wrong answer here opens an editor on a session or
// tries to stream a source file.
const session = "/home/me/.pi/agent/sessions/x/2026-09-23T01_22_33_abc.jsonl";
assert.equal(isFileTab(session), false);

// A path containing the prefix later on is still a session.
assert.equal(isFileTab("/home/me/file:weird/s.jsonl"), false);

// A file literally named like the prefix still round-trips.
const odd = fileTab("/home/me/file:weird/a.ts");
assert.equal(isFileTab(odd), true);
assert.equal(tabPath(odd), "/home/me/file:weird/a.ts");

// A dotfile has no extension to strip, and a trailing slash has no basename.
assert.equal(tabLabel(fileTab("/home/me/proj/.gitignore")), ".gitignore");
assert.equal(tabLabel(fileTab("/")), "/");

// --- diff entries ----------------------------------------------------------
// A diff round-trips its commit AND its path.
const d = diffTab("a4a8539", "scripts/make_kit.py");
assert.equal(isDiffTab(d), true);
assert.equal(isFileTab(d), false);
assert.deepEqual(diffParts(d), { ref: "a4a8539", path: "scripts/make_kit.py" });
assert.equal(tabPath(d), "scripts/make_kit.py");

// The working tree is the empty ref, and must not be confused with a commit.
const w = diffTab("", "src/App.tsx");
assert.deepEqual(diffParts(w), { ref: "", path: "src/App.tsx" });
assert.match(tabLabel(w), /working tree/);
// A commit's label carries the sha, so the same file at two revisions is two
// distinguishable tabs rather than two identical ones.
assert.equal(tabLabel(d), "make_kit.py (a4a8539)");
assert.notEqual(tabLabel(d), tabLabel(diffTab("", "scripts/make_kit.py")));

// A path containing a colon splits at the FIRST one only: the sha never has
// one, so everything after it is the path.
assert.deepEqual(diffParts(diffTab("abc123", "weird:name.ts")), {
	ref: "abc123",
	path: "weird:name.ts",
});

// THE invariant App depends on: only a session is ever attached to. A diff
// entry that merely failed the file test would be handed to the EventSource
// as a session path and stream a 404 forever.
assert.equal(isSessionTab(session), true);
assert.equal(isSessionTab(d), false);
assert.equal(isSessionTab(w), false);
assert.equal(isSessionTab(t), false);

// --- pinnedFirst -----------------------------------------------------------
assert.deepEqual(pinnedFirst(["a", "b", "c", "d"], ["d", "b"]), ["b", "d", "a", "c"]);
assert.deepEqual(pinnedFirst(["a", "b"], ["x"]), ["a", "b"]);

// --- moveTab ---------------------------------------------------------------
const strip = ["a", "b", "c", "d"];

// Rightward: the dragged tab lands AT the target index, the rest close the gap.
assert.deepEqual(moveTab(strip, 0, 2), ["b", "c", "a", "d"]);
// Leftward.
assert.deepEqual(moveTab(strip, 3, 1), ["a", "d", "b", "c"]);
// Neighbour swap, the common case and what Ctrl+Shift+Arrow does.
assert.deepEqual(moveTab(strip, 1, 2), ["a", "c", "b", "d"]);
// To either end.
assert.deepEqual(moveTab(strip, 2, 0), ["c", "a", "b", "d"]);
assert.deepEqual(moveTab(strip, 0, 3), ["b", "c", "d", "a"]);

// Never mutates its input: App holds the previous array in a ref.
assert.deepEqual(strip, ["a", "b", "c", "d"]);

// A no-op returns the SAME array, which is how App detects "nothing to commit"
// and skips the re-render and the localStorage write.
assert.equal(moveTab(strip, 1, 1), strip);
// Out of range is a no-op, not a throw: a drag can outlive the strip it began
// in, and a stale index must not teleport a tab or crash mid-gesture.
assert.equal(moveTab(strip, -1, 2), strip);
assert.equal(moveTab(strip, 0, 9), strip);
assert.equal(moveTab(strip, 9, 0), strip);
assert.deepEqual(moveTab([], 0, 1), []);

// Mixed strip: files and sessions reorder by POSITION, not by kind — a file
// tab can sit between two chats, which is the point of having one strip.
const mixed = ["/s/1.jsonl", fileTab("/p/a.ts"), "/s/2.jsonl"];
assert.deepEqual(moveTab(mixed, 1, 0), [fileTab("/p/a.ts"), "/s/1.jsonl", "/s/2.jsonl"]);

// --- withoutTab / withTab: the split's two mutations -----------------------
const group = { files: ["a", "b", "c"], active: "b" };

// Closing the SHOWING tab selects the one that slid into its slot.
assert.deepEqual(withoutTab(group, "b"), { files: ["a", "c"], active: "c" });
// Closing the rightmost falls back to its LEFT neighbour — there is no slot to
// slide into, and landing on the empty pane is the bug this rule prevents.
assert.deepEqual(withoutTab({ files: ["a", "b"], active: "b" }, "b"), {
	files: ["a"],
	active: "a",
});
// Closing a background tab leaves the selection alone: the pane must not
// change under you because something else closed.
assert.deepEqual(withoutTab(group, "a"), { files: ["b", "c"], active: "b" });
// Emptying the group yields no active tab, which is what tells App to collapse
// the split rather than render a divider and a blank pane.
assert.deepEqual(withoutTab({ files: ["a"], active: "a" }, "a"), { files: [], active: undefined });
// Not here: null, so a caller can tell "nothing to do" from "removed the last
// one" — they need different handling, and both have empty-ish results.
assert.equal(withoutTab(group, "zzz"), null);

// Adding focuses; adding twice does NOT duplicate. Dropping a tab onto the
// column it already lives in is the common way to hit this.
assert.deepEqual(withTab(group, "d"), { files: ["a", "b", "c", "d"], active: "d" });
assert.deepEqual(withTab(group, "a"), { files: ["a", "b", "c"], active: "a" });
assert.deepEqual(withTab({ files: [] }, "a"), { files: ["a"], active: "a" });

// Neither mutates: App holds the previous group in a ref and compares.
assert.deepEqual(group, { files: ["a", "b", "c"], active: "b" });



// --- halfOf: which side a drop lands on ------------------------------------
// The midpoint belongs to the RIGHT half, so a drop exactly on the seam
// splits rather than silently doing nothing.
assert.equal(halfOf(10, 0, 100), "left");
assert.equal(halfOf(50, 0, 100), "right");
assert.equal(halfOf(90, 0, 100), "right");
// Offset boxes: the second column does not start at x=0, and using clientX
// against a zero origin would make its whole body read as "right".
assert.equal(halfOf(510, 500, 100), "left");
assert.equal(halfOf(590, 500, 100), "right");
// --- groupOf / withGroup: the split's two columns --------------------------
const split = { files: ["s1", "f1"], active: "s1", right: { files: ["f2"], active: "f2" } };

// Each side reads back as a plain group, whichever half it is.
assert.deepEqual(groupOf(split, "left"), { files: ["s1", "f1"], active: "s1" });
assert.deepEqual(groupOf(split, "right"), { files: ["f2"], active: "f2" });
// Unsplit: the right column reads as empty rather than undefined, so callers
// can treat both sides the same without a null check.
assert.deepEqual(groupOf({ files: ["a"], active: "a" }, "right"), { files: [] });

// Writing the left column keeps it FLAT, which is the shape already persisted
// under pwi:tabs:<project> — nesting it would drop everyone's open tabs.
assert.deepEqual(withGroup(split, "left", { files: ["x"], active: "x" }), {
	files: ["x"],
	active: "x",
	right: { files: ["f2"], active: "f2" },
});

// Emptying the SECOND column collapses the split: a column with no tabs is a
// divider and a blank pane.
assert.deepEqual(withGroup(split, "right", { files: [] }), {
	files: ["s1", "f1"],
	active: "s1",
	right: undefined,
});
// Emptying the FIRST column does not: it owns the empty-state hint, and there
// would be nowhere left to put a tab back.
assert.deepEqual(withGroup(split, "left", { files: [] }), {
	files: [],
	active: undefined,
	right: { files: ["f2"], active: "f2" },
});

// A SESSION moves between columns like any other entry — the chat follows the
// selection rather than being pinned to the left column.
const moved = withGroup(withGroup(split, "left", withoutTab(groupOf(split, "left"), "s1")!), "right", withTab(groupOf(split, "right"), "s1"));
assert.deepEqual(moved.files, ["f1"]);
assert.deepEqual(moved.right, { files: ["f2", "s1"], active: "s1" });

// --- slotFor: which GAP a drag aims at ------------------------------------
// A slot is a gap, 0..n. Over tab 2's left half means the gap before it (2),
// over its right half the gap after (3) — that is what makes a drag point
// somewhere instead of every hover over one tab meaning one position.
assert.equal(slotFor(100, 100, 40, 2), 2); // hard left edge
assert.equal(slotFor(119, 100, 40, 2), 2); // just before the midpoint
assert.equal(slotFor(120, 100, 40, 2), 3); // the midpoint belongs to the right
assert.equal(slotFor(139, 100, 40, 2), 3); // hard right edge

// The strip scrolls and the second column does not start at x=0, so the box
// offset has to be honoured rather than assumed away.
assert.equal(slotFor(505, 500, 40, 0), 0);
assert.equal(slotFor(535, 500, 40, 0), 1);

// Dropping a tab back on its own two slots is a no-op: with `from` = 2, both
// slot 2 and slot 3 mean "where it already is". App converts slot to index by
// subtracting one when the slot is past the source.
for (const [slot, from] of [[2, 2], [3, 2]]) {
	assert.equal(slot > from ? slot - 1 : slot, from);
}
// Moving right: slot 5 with the tab removed from index 2 lands at index 4.
assert.equal(5 > 2 ? 5 - 1 : 5, 4);
// Moving left needs no shift: slot 1 is index 1.
assert.equal(1 > 2 ? 0 : 1, 1);

// --- sideOfTab: the rule attach() used to get wrong ------------------------
// The bug: a session dragged into the right column is still the ATTACHED
// session, so reloading re-attached it — and attach appended a second tab for
// it on the left. One session in both columns, and the left copy rendered an
// empty pane because the chat can only be in one place.
const s2 = { files: ["f1"], active: "f1", right: { files: ["sess"], active: "sess" } };
assert.equal(sideOfTab(s2, "sess"), "right");
assert.equal(sideOfTab(s2, "f1"), "left");
assert.equal(sideOfTab(s2, "nope"), null);

// The right column wins when an entry is somehow in both, so a duplicate
// collapses toward the column actually showing it.
assert.equal(sideOfTab({ files: ["x"], right: { files: ["x"] } }, "x"), "right");

// A session with no JSONL yet is keyed by id until the file exists; both keys
// mean the same tab, or attach would add a second one when the file appears.
assert.equal(sideOfTab({ files: [], right: { files: ["id-7"] } }, "/s.jsonl", "id-7"), "right");
assert.equal(sideOfTab({ files: ["id-7"] }, "/s.jsonl", "id-7"), "left");

// Unsplit: nothing is ever on the right.
assert.equal(sideOfTab({ files: ["a"], active: "a" }, "a"), "left");

// --- collapse: closing the last tab on the LEFT must not leave a blank pane --
// The mirror of withGroup's rule for the right column: the second column's
// tabs slide over and the split closes.
assert.deepEqual(collapse({ files: [], right: { files: ["a", "b"], active: "b" } }), {
	files: ["a", "b"],
	active: "b",
	right: undefined,
});
// Unsplit and empty stays empty — there is nothing to slide over.
assert.deepEqual(collapse({ files: [] }), { files: [] });
// A non-empty left column is untouched.
const kept = { files: ["a"], active: "a", right: { files: ["b"], active: "b" } };
assert.equal(collapse(kept), kept);

// --- afterPathChange: a rename or delete from the explorer ---
{
	const a = fileTab("/p/src/a.ts");
	const b = fileTab("/p/src/b.ts");
	const other = fileTab("/p/srcx/c.ts");
	const d = diffTab("", "src/a.ts");
	const tabs = { files: ["/s.jsonl", a, other, d], active: a, right: { files: [b], active: b } };
	// A folder rename carries every file under it, in both columns, and keeps the selection.
	assert.deepEqual(afterPathChange(tabs, "/p/src", "/p/lib"), {
		files: ["/s.jsonl", fileTab("/p/lib/a.ts"), other, d],
		active: fileTab("/p/lib/a.ts"),
		right: { files: [fileTab("/p/lib/b.ts")], active: fileTab("/p/lib/b.ts") },
	});
	// A delete closes them: the selection moves to a neighbour, an emptied right column goes.
	assert.deepEqual(afterPathChange(tabs, "/p/src", null), {
		files: ["/s.jsonl", other, d],
		active: other,
		right: undefined,
	});
	// A prefix sibling (`/p/srcx`) is a different folder.
	assert.equal(afterPathChange(tabs, "/p/src", null).files.includes(other), true);
}

console.log("tabs: ok");
