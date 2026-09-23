// Run: node --import tsx src/web/prefs.test.ts
//
// `readPanel` only: it is the one pref with a fallback arm (the old
// `pwi:terminal` boolean), and the failure it guards against is silent — a
// bad stored value would leave the rail pointing at a panel that does not
// exist, or reset everyone's open panel on upgrade.
import assert from "node:assert/strict";

// prefs.ts touches localStorage at import time (the piw:→pwi: migration), so
// the stub has to exist before the import.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
};

const { readPanel, writePanel } = await import("./prefs.js");

// Nothing stored at all: no panel, not a crash and not a default-open rail.
assert.equal(readPanel(), null);

// The upgrade path: an old open terminal is still open after this change.
store.set("pwi:terminal", "1");
assert.equal(readPanel(), "terminal");

// A new value wins over the legacy boolean, including the closed state —
// otherwise a terminal closed after upgrading would reopen forever.
writePanel("editor");
assert.equal(readPanel(), "editor");
writePanel(null);
assert.equal(readPanel(), null);

// Storage is user-writable; an unknown panel closes rather than renders.
store.set("pwi:panel", "nonsense");
assert.equal(readPanel(), null);

console.log("prefs ok");
