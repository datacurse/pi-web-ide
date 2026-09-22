// Run: node --import tsx src/web/drafts.test.ts
//
// A fake localStorage with a settable byte ceiling, because the interesting
// half of drafts.ts is what it does when a pasted screenshot does not fit.
import assert from "node:assert/strict";
import { clearDraft, readDraft, writeDraftImages, writeDraftText } from "./drafts.js";

let limit = 1e9;
const store = new Map<string, string>();
const size = () => [...store].reduce((n, [k, v]) => n + k.length + v.length, 0);

/*
 * `Storage` carries an index signature for its `storage.foo` form, which this
 * fake has no use for and cannot express; drafts.ts only ever calls the five
 * methods below.
 */
const fake = {
	get length() {
		return store.size;
	},
	key: (i: number) => [...store.keys()][i] ?? null,
	getItem: (k: string) => store.get(k) ?? null,
	removeItem: (k: string) => void store.delete(k),
	setItem: (k: string, v: string) => {
		const without = size() - (store.has(k) ? k.length + (store.get(k) ?? "").length : 0);
		if (without + k.length + v.length > limit) {
			const err = new Error("QuotaExceededError");
			err.name = "QuotaExceededError";
			throw err;
		}
		store.set(k, v);
	},
	clear: () => store.clear(),
} as unknown as Storage;

globalThis.localStorage = fake;

const img = (bytes: number) => [{ data: "x".repeat(bytes), mimeType: "image/png" }];

// Text and attachments both come back, and independently: the two live in
// separate entries so a keystroke does not rewrite megabytes of base64.
writeDraftText("a", "half-written question");
writeDraftImages("a", img(50));
assert.equal(readDraft("a").text, "half-written question");
assert.equal(readDraft("a").images.length, 1);

// Drafts are per session: one composer's text never surfaces in another's.
writeDraftText("b", "different session");
assert.equal(readDraft("a").text, "half-written question");
assert.equal(readDraft("b").images.length, 0);

// Out of quota: the images being staged NOW win, and another session's are
// dropped to make room rather than the new ones being silently lost.
clearDraft("a");
clearDraft("b");
assert.equal(writeDraftImages("old", img(200)), true);
limit = size() + 60;
assert.equal(writeDraftImages("new", img(200)), true);
assert.equal(readDraft("old").images.length, 0);
assert.equal(readDraft("new").images.length, 1);

// Too big even with the whole quota to itself: reported, and NO stale entry
// left behind to be restored in place of what is really attached.
assert.equal(writeDraftImages("new", img(5000)), false);
assert.equal(readDraft("new").images.length, 0);

limit = 1e9;

// Sending clears both entries.
writeDraftText("new", "typed but not sent");
writeDraftImages("new", img(10));
clearDraft("new");
assert.deepEqual(readDraft("new"), { text: "", images: [] });

// An empty composer is not a draft, so it leaves no key to be pruned later.
writeDraftText("ghost", "");
assert.equal(localStorage.getItem("pwi:draft:ghost"), null);

// Storage is user-writable: anything unrecognisable reads as "no draft"
// instead of throwing on render.
localStorage.setItem("pwi:draft:junk", "not json");
localStorage.setItem("pwi:draft-images:junk", JSON.stringify([{ data: 5 }, "nope", null]));
assert.deepEqual(readDraft("junk"), { text: "", images: [] });

// Nothing deletes a session from this browser's point of view, so the drafts
// cap is the only thing that reclaims a screenshot nobody will come back for.
store.clear();
for (let i = 0; i < 20; i++) {
	store.set(`pwi:draft:s${i}`, JSON.stringify({ text: `t${i}`, at: 1000 + i }));
}
writeDraftText("fresh", "newest");
assert.ok([...store.keys()].filter((k) => k.startsWith("pwi:draft:s")).length <= 15);
assert.equal(readDraft("s0").text, "");
assert.equal(readDraft("s19").text, "t19");
assert.equal(readDraft("fresh").text, "newest");

console.log("ok");
