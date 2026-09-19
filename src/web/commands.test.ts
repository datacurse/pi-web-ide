// Run: node --import tsx src/web/commands.test.ts
import assert from "node:assert/strict";
import { completionOptions, parseCompletion } from "./commands.js";
import type { PiCommand } from "../shared/types.js";

const catalog: PiCommand[] = [
	{ name: "model", description: "Show current model selection", aliases: ["models"] },
	{
		name: "compact",
		description: "Compact the conversation",
		hint: "[soft|remote]",
		subcommands: [
			{ name: "soft", description: "Summarize locally" },
			{ name: "remote", description: "Summarize via the provider" },
		],
	},
	{ name: "context", description: "Show context usage" },
];

// The picker opens on a bare slash, and every command is a candidate.
assert.deepEqual(parseCompletion("/"), { kind: "command", query: "" });
assert.equal(completionOptions(catalog, { kind: "command", query: "" }).length, 3);

// A slash is only a command at the start of an otherwise empty composer.
// Prose that happens to contain one must not raise a picker.
assert.equal(parseCompletion("and/or"), null);
assert.equal(parseCompletion("/compact\nand more"), null);
assert.equal(parseCompletion("tell me about /compact"), null);

// Arguments past the subcommand word are the user's text, not a name we can
// complete, so the picker gets out of the way.
assert.equal(parseCompletion("/compact soft focus on the tunnels"), null);

// Accepting a command leaves a trailing space, and THAT is the state that
// offers its subcommands — one keypress chains into the next list.
assert.deepEqual(parseCompletion("/compact "), { kind: "sub", name: "compact", query: "" });
assert.deepEqual(
	completionOptions(catalog, { kind: "sub", name: "compact", query: "" }).map((o) => o.insert),
	["/compact soft ", "/compact remote "],
);
// ...and a completed subcommand closes it again.
assert.equal(parseCompletion("/compact soft "), null);

// A command with no subcommands has nothing to offer once it is named.
assert.deepEqual(completionOptions(catalog, { kind: "sub", name: "context", query: "" }), []);

// Prefix matches rank above substring ones: typing "co" wants /compact and
// /context before it wants anything that merely contains "co".
assert.deepEqual(
	completionOptions(
		[...catalog, { name: "add-dir", description: "no relation, contains no co" }],
		{ kind: "command", query: "co" },
	).map((o) => o.label),
	["/compact", "/context"],
);

// Aliases match, but the row inserts the canonical name: the subcommand list
// and every later lookup are keyed by it.
const aliased = completionOptions(catalog, { kind: "command", query: "models" });
assert.deepEqual(
	aliased.map((o) => o.insert),
	["/model "],
);
assert.equal(aliased[0]?.label, "/model");

// Subcommand rows read as the word they are; a leading slash would claim a
// top-level command that does not exist.
assert.equal(
	completionOptions(catalog, { kind: "sub", name: "compact", query: "so" })[0]?.label,
	"soft",
);

// An unknown command completes to nothing rather than to everything.
assert.deepEqual(completionOptions(catalog, { kind: "command", query: "zzz" }), []);
assert.deepEqual(completionOptions(catalog, { kind: "sub", name: "zzz", query: "" }), []);

console.log("ok");
