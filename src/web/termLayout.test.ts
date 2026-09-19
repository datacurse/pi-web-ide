// Run: node --import tsx src/web/termLayout.test.ts
import assert from "node:assert/strict";
import {
	addTab,
	allTerminals,
	EMPTY_LAYOUT,
	focusedTerminal,
	focusTerminal,
	MIN_SPLIT_PERCENT,
	parseLayout,
	reconcile,
	removeTerminal,
	resizeSplit,
	selectTab,
	splitActive,
	toggleDirection,
} from "./termLayout.js";

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

// One tab, one shell, focused: the first thing anyone sees.
let layout = addTab(EMPTY_LAYOUT, "a");
assert.deepEqual(layout, {
	tabs: [{ terminals: ["a"], direction: "row", sizes: [100], focus: "a" }],
	active: 0,
});

/*
 * A split lands NEXT TO the pane it split, not at the end: with three panes
 * open, splitting the middle one has to appear in the middle, or the layout
 * does not match the gesture that produced it.
 */
layout = splitActive(layout, "b");
layout = splitActive(focusTerminal(layout, "a"), "c");
assert.deepEqual(layout.tabs[0].terminals, ["a", "c", "b"]);
assert.equal(focusedTerminal(layout), "c");
// Shares stay even and complete: a missing percent is a visible seam.
assert.equal(sum(layout.tabs[0].sizes), 100);

// A second tab is its own split group, and becomes active.
layout = addTab(layout, "d");
assert.equal(layout.active, 1);
assert.deepEqual(layout.tabs[1].terminals, ["d"]);
assert.deepEqual(allTerminals(layout), ["a", "c", "b", "d"]);

/*
 * Focus is per TAB: coming back to a tab lands on the pane you left, not on
 * its first one. This is the whole reason focus is not a single field.
 */
layout = focusTerminal(layout, "b");
assert.equal(layout.active, 0);
layout = selectTab(layout, 1);
assert.equal(focusedTerminal(layout), "d");
layout = selectTab(layout, 0);
assert.equal(focusedTerminal(layout), "b");

// Direction is per tab, because one tab can want side-by-side and another
// stacked.
layout = toggleDirection(layout);
assert.equal(layout.tabs[0].direction, "column");
assert.equal(layout.tabs[1].direction, "row");

/*
 * A divider moves only the pair it sits between. Redistributing across every
 * pane would move panes the user is not touching, and the total must stay at
 * 100 or the last pane grows and shrinks on its own.
 */
layout = resizeSplit(layout, 0, 50);
assert.equal(layout.tabs[0].sizes[0], 50);
assert.equal(sum(layout.tabs[0].sizes), 100);
const thirdBefore = layout.tabs[0].sizes[2];
layout = resizeSplit(layout, 0, 20);
assert.equal(layout.tabs[0].sizes[2], thirdBefore);

// And it cannot collapse a pane into a seam you can no longer grab.
layout = resizeSplit(layout, 0, -500);
assert.equal(layout.tabs[0].sizes[0], MIN_SPLIT_PERCENT);
assert.equal(sum(layout.tabs[0].sizes), 100);

/*
 * Closing a split moves focus to a neighbour IN THE SAME TAB, so the keyboard
 * stays somewhere real instead of landing in another tab's shell.
 */
layout = focusTerminal(layout, "c");
layout = removeTerminal(layout, "c");
assert.deepEqual(layout.tabs[0].terminals, ["a", "b"]);
assert.equal(focusedTerminal(layout), "b");
assert.equal(sum(layout.tabs[0].sizes), 100);

/*
 * A tab that loses its last split closes with it — an empty tab shows
 * nothing and cannot be filled — and the active index has to follow, or the
 * pane renders whichever tab slid into that slot.
 */
layout = selectTab(layout, 1);
layout = removeTerminal(layout, "d");
assert.equal(layout.tabs.length, 1);
assert.equal(layout.active, 0);
assert.equal(focusedTerminal(layout), "b");

// Removing something that is not there is not an error and not a change.
assert.equal(removeTerminal(layout, "nope"), layout);

/*
 * RECONCILE is the whole recovery path after a reload, and it has to work in
 * both directions: drop ids the server no longer has (panes wired to nothing)
 * and adopt ids it has that the layout does not mention — an unreferenced
 * shell is unreachable, so nothing could close it either.
 */
const stored = addTab(splitActive(addTab(EMPTY_LAYOUT, "x"), "y"), "z");
const recovered = reconcile(stored, ["y", "w"]);
assert.deepEqual(allTerminals(recovered), ["y", "w"]);
assert.equal(recovered.tabs[0].focus, "y");
assert.equal(sum(recovered.tabs[0].sizes), 100);

// Nothing left at all is the empty pane, not a layout of empty tabs.
assert.deepEqual(reconcile(stored, []), EMPTY_LAYOUT);

/*
 * Storage is user-writable and outlives renames, so a stored layout is
 * untrusted input: a shape that cannot be rendered must come back empty
 * rather than reaching render half-formed.
 */
assert.deepEqual(parseLayout(null), EMPTY_LAYOUT);
assert.deepEqual(parseLayout("nope"), EMPTY_LAYOUT);
assert.deepEqual(parseLayout({ tabs: "no" }), EMPTY_LAYOUT);
assert.deepEqual(parseLayout({ tabs: [{ terminals: [] }] }), EMPTY_LAYOUT);
assert.deepEqual(parseLayout({ tabs: [{ terminals: [1, "a"] }] }).tabs[0].terminals, ["a"]);

// Sizes only survive if they still describe this many panes; a mismatched
// array renders as panes of arbitrary width, which is worse than even shares.
const parsed = parseLayout({
	tabs: [{ terminals: ["a", "b"], direction: "column", sizes: [70], focus: "gone" }],
	active: 9,
});
assert.deepEqual(parsed.tabs[0].sizes, [50, 50]);
assert.equal(parsed.tabs[0].direction, "column");
assert.equal(parsed.active, 0);
assert.equal(parsed.tabs[0].focus, "a");

// A layout that is intact comes back exactly as stored, sizes included.
const intact = {
	tabs: [{ terminals: ["a", "b"], direction: "row" as const, sizes: [70, 30], focus: "b" }],
	active: 0,
};
assert.deepEqual(parseLayout(intact), intact);

console.log("ok");
