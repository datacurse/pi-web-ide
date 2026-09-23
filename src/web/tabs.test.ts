// Run: node --import tsx src/web/tabs.test.ts
import assert from "node:assert/strict";
import { fileTab, isFileTab, moveTab, tabLabel, tabPath } from "./tabs.js";

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

console.log("tabs: ok");
