import assert from "node:assert/strict";
import { summarise } from "./GitActions.js";

// The bug: `git push` writes "To github.com:you/repo.git" as the first line of
// its stderr, so showing the last step's output put a remote URL beside the
// button after every push.
assert.equal(
	summarise({
		ok: true,
		steps: [
			{ step: "commit", output: "[main abc1234] Fix the thing" },
			{ step: "push", output: "To github.com:datacurse/pi-web-ide.git\n   a1b2c3d..e4f5g6h  main -> main" },
		],
	}),
	"Committed · Pushed",
);

// A branch step carries its name ("branch pwi/2026-09-23-1432"); only the verb
// is wanted.
assert.equal(
	summarise({
		ok: true,
		steps: [
			{ step: "branch pwi/2026-09-23-1432", output: "" },
			{ step: "commit", output: "" },
			{ step: "push", output: "To github.com:x/y.git" },
		],
	}),
	"Branched · Committed · Pushed",
);

assert.equal(summarise({ ok: true, steps: [{ step: "commit", output: "" }] }), "Committed");

// A PR's URL IS the result, and the thing you want to click.
assert.equal(
	summarise({
		ok: true,
		steps: [{ step: "pull request", output: "https://github.com/x/y/pull/7" }],
		url: "https://github.com/x/y/pull/7",
	}),
	"https://github.com/x/y/pull/7",
);

// Never empty: a toast with no text is a toast that looks broken.
assert.equal(summarise({ ok: true, steps: [] }), "Done");

console.log("git summarise: ok");
