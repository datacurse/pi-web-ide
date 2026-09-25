// Run: node --import tsx src/server/remind-extension.test.ts
import assert from "node:assert/strict";
import { withReminder } from "./remind-extension.js";

const tag = { type: "text", text: "<system-reminder>\nbe terse\n</system-reminder>" };

// Every user message gets it, whether its content is a string or parts.
const messages = [
	{ role: "user", content: "first" },
	{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	{ role: "user", content: [{ type: "text", text: "second" }] },
	{ role: "toolResult", content: [{ type: "text", text: "out" }] },
];
const out = withReminder(messages, "be terse");
assert.deepEqual(out[0]!.content, [{ type: "text", text: "first" }, tag]);
assert.deepEqual(out[2]!.content, [{ type: "text", text: "second" }, tag]);
assert.equal(out[1], messages[1], "assistant message untouched");
assert.equal(out[3], messages[3], "tool result untouched");
assert.deepEqual(messages[2]!.content, [{ type: "text", text: "second" }], "input not mutated");

// The next request sends the earlier messages byte-for-byte as before, so the
// prompt cache and earlier thinking blocks stay valid.
const next = withReminder(
	[...messages, { role: "assistant", content: [] }, { role: "user", content: "third" }],
	"be terse",
);
assert.equal(JSON.stringify(next.slice(0, out.length)), JSON.stringify(out));
assert.deepEqual(next.at(-1)!.content, [{ type: "text", text: "third" }, tag]);

// Empty text: nothing to do. No user message: nothing changes.
assert.equal(withReminder(messages, ""), messages);
const none = [{ role: "assistant", content: [] }];
assert.deepEqual(withReminder(none, "x"), none);

console.log("ok");
