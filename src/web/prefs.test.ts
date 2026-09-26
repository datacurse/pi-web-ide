// Run: node --import tsx src/web/prefs.test.ts
//
// `readPanel`: a bad stored value would silently leave the rail pointing at
// a panel that does not exist.
import assert from "node:assert/strict";

// Stub localStorage before the import.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
};

const prefs = await import("./prefs.js");
const { readPanel, writePanel } = prefs;

// Nothing stored at all: no panel, not a crash and not a default-open rail.
assert.equal(readPanel(), null);

writePanel("editor");
assert.equal(readPanel(), "editor");
writePanel(null);
assert.equal(readPanel(), null);

// Storage is user-writable; an unknown panel closes rather than renders.
store.set("pwi:panel", "nonsense");
assert.equal(readPanel(), null);

// The terminal left the side panel for the dock: an old stored "terminal"
// panel closes the panel and opens the dock instead.
const { readDockOpen, writeDockOpen, readDockHeight } = prefs;
store.set("pwi:panel", "terminal");
assert.equal(readPanel(), null);
assert.equal(readDockOpen(), true);
writeDockOpen(false);
assert.equal(readDockOpen(), false);
store.set("pwi:dockHeight", "2");
assert.equal(readDockHeight(), 15);

// --- explorer expansion, per project --------------------------------------
const { readExplorerOpen, writeExplorerOpen } = prefs;

// Nothing stored: nothing expanded, and the tree renders collapsed.
assert.deepEqual(readExplorerOpen("/p"), []);

writeExplorerOpen("/p", ["/p/src", "/p/src/web"]);
assert.deepEqual(readExplorerOpen("/p"), ["/p/src", "/p/src/web"]);

// Per PROJECT: another cwd's expansions are paths this tree does not have.
assert.deepEqual(readExplorerOpen("/other"), []);

// Collapsing everything is a real state, not "never set".
writeExplorerOpen("/p", []);
assert.deepEqual(readExplorerOpen("/p"), []);

// Storage is user-writable, so a wrong shape degrades instead of throwing
// during render.
localStorage.setItem("pwi:explorer:/bad", "{not json");
assert.deepEqual(readExplorerOpen("/bad"), []);
localStorage.setItem("pwi:explorer:/obj", '{"a":1}');
assert.deepEqual(readExplorerOpen("/obj"), []);
localStorage.setItem("pwi:explorer:/mixed", '["/p/ok", 7, null]');
assert.deepEqual(readExplorerOpen("/mixed"), ["/p/ok"]);

console.log("prefs ok");
