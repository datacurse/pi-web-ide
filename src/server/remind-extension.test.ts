// Run: node --import tsx src/server/remind-extension.test.ts
import assert from "node:assert/strict";
import { withReminder } from "./remind-extension.js";

const tag = { type: "text", text: "<system-reminder>\nbe terse\n</system-reminder>" };

// Only the LATEST user message gets it, whether its content is a string or parts.
const messages = [
	{ role: "user", content: "first" },
	{ role: "assistant", content: [{ type: "text", text: "ok" }] },
	{ role: "user", content: [{ type: "text", text: "second" }] },
	{ role: "toolResult", content: [{ type: "text", text: "out" }] },
];
const out = withReminder(messages, "be terse");
assert.deepEqual(out[2]!.content, [{ type: "text", text: "second" }, tag]);
assert.equal(out[0], messages[0], "earlier user message untouched");
assert.equal(out[3], messages[3], "tool result untouched");
assert.deepEqual(messages[2]!.content, [{ type: "text", text: "second" }], "input not mutated");

assert.deepEqual(withReminder([{ role: "user", content: "hi" }], "be terse")[0]!.content, [
	{ type: "text", text: "hi" },
	tag,
]);

// Empty text or no user message: nothing to do.
assert.equal(withReminder(messages, ""), messages);
const none = [{ role: "assistant", content: [] }];
assert.equal(withReminder(none, "x"), none);

console.log("ok");
