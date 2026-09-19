// Run: node --import tsx src/web/commands.test.ts
import assert from "node:assert/strict";
import { completionOptions, parseCompletion } from "./commands.js";
import type { PiCommand } from "../shared/types.js";

const catalog: PiCommand[] = [
	{ name: "compact", description: "Compact the conversation", source: "extension" },
	{ name: "context", description: "Show context usage", source: "extension" },
	{ name: "skill:brave-search", description: "Web search", source: "skill" },
];

// The picker opens on the command word and only on it.
assert.deepEqual(parseCompletion("/"), { query: "" });
assert.deepEqual(parseCompletion("/co"), { query: "co" });

// A slash mid-sentence is prose, not a command: "and/or" must not open a panel
// over the composer while someone is writing.
assert.equal(parseCompletion("do it and/or skip"), null);
assert.equal(parseCompletion("/compact\nmore"), null);

// Past the name the user is writing an argument, which the picker cannot help
// with — and a panel covering the text being typed is worse than no panel.
assert.equal(parseCompletion("/compact soft"), null);
assert.equal(parseCompletion("/compact "), null);

// Prefix matches rank above substring ones: typing "co" wants /compact and
// /context first, not a skill that merely contains "co".
const co = completionOptions(catalog, { query: "co" }).map((o) => o.label);
assert.deepEqual(co, ["/compact", "/context"]);

// Substring matching is what makes a long skill name findable from its
// distinctive middle, which is rarely its first letters.
assert.deepEqual(
	completionOptions(catalog, { query: "brave" }).map((o) => o.label),
	["/skill:brave-search"],
);

// Accepting a row leaves the caret where the argument goes.
assert.equal(completionOptions(catalog, { query: "com" })[0].insert, "/compact ");

// The source tag rides along, so the picker can say where a command came from.
assert.equal(completionOptions(catalog, { query: "brave" })[0].source, "skill");

assert.deepEqual(completionOptions(catalog, { query: "zzz" }), []);

console.log("ok");
