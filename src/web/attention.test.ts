// Run: node --import tsx src/web/attention.test.ts
import assert from "node:assert/strict";
import type { PiSessionInfo } from "../shared/types.js";
import { attentionOf, attentionTitle, nextWaiting, type Attention } from "./attention.js";

const session = (path: string, lastActive: string, extra: Partial<PiSessionInfo> = {}): PiSessionInfo => ({
	id: path,
	path,
	created: lastActive,
	lastActive,
	messageCount: 1,
	firstMessage: "",
	...extra,
});

const seen = { baseline: "2025-01-01T00:00:00.000Z", seen: { "/b": "2025-01-03T00:00:00.000Z" } };

// Older than the baseline: never flagged, so an upgrade does not light up history.
assert.equal(attentionOf(session("/a", "2024-12-31T00:00:00.000Z"), seen), null);
// Newer than the baseline and never viewed: a reply waiting.
assert.equal(attentionOf(session("/a", "2025-01-02T00:00:00.000Z"), seen), "ready");
// Viewed after its last activity: nothing new.
assert.equal(attentionOf(session("/b", "2025-01-02T00:00:00.000Z"), seen), null);
assert.equal(attentionOf(session("/b", "2025-01-04T00:00:00.000Z"), seen), "ready");
// Working beats ready; a question beats both, since the agent is blocked on it.
assert.equal(attentionOf(session("/b", "2025-01-04T00:00:00.000Z", { isStreaming: true }), seen), "working");
assert.equal(
	attentionOf(session("/b", "2025-01-04T00:00:00.000Z", { isStreaming: true, needsInput: true }), seen),
	"needs",
);

assert.equal(attentionTitle([]), "pwi");
assert.equal(attentionTitle(["working", null]), "\u25cf pwi");
assert.equal(attentionTitle(["ready", "needs", "working"]), "2 \u25cf pwi");
assert.equal(attentionTitle(["ready"]), "1 pwi");

const list = [
	session("/new-ready", "2025-01-05T00:00:00.000Z"),
	session("/old-ready", "2025-01-02T00:00:00.000Z"),
	session("/asking", "2025-01-06T00:00:00.000Z"),
	session("/busy", "2025-01-01T00:00:00.000Z"),
];
const states = new Map<string, Attention>([
	["/new-ready", "ready"],
	["/old-ready", "ready"],
	["/asking", "needs"],
	["/busy", "working"],
]);
// Questions first, then the reply that has waited longest; the current one is skipped.
assert.equal(nextWaiting(list, states, undefined), "/asking");
assert.equal(nextWaiting(list, states, "/asking"), "/old-ready");
assert.equal(nextWaiting([list[3]!], states, undefined), undefined);

console.log("attention ok");
