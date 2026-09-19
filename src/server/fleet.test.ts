// Run: node --import tsx src/server/fleet.test.ts
//
// The manifest's rules. They are small and they are the whole guarantee: an
// unpinned entry means two machines reconciling a week apart install two
// different versions, and the fleet has quietly stopped being one fleet.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adopt, readManifest, writeManifest } from "./fleet.js";

// Resolved per call, so setting these after the import is safe.
const dir = mkdtempSync(join(tmpdir(), "piw-fleet-"));
process.env.PIW_STATE_DIR = dir;
const file = join(dir, "packages.json");

// A machine with no manifest reconciles to "leave everything alone", which
// is the only safe reading of "I have not been told anything yet".
assert.deepEqual(readManifest(), { version: 1, packages: [] });

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
const saved = writeManifest({
	version: 1,
	packages: [
		{ source: "npm:pi-lens@4.2.1" },
		{ source: "git:github.com/datacurse/pi-config@v3", exclude: ["tg"] },
	],
});
assert.deepEqual(saved.packages, [
	{ source: "npm:pi-lens@4.2.1" },
	{ source: "git:github.com/datacurse/pi-config@v3", exclude: ["tg"] },
]);
assert.deepEqual(readManifest(), saved, "round-trips through the file");

// THE rule.
assert.throws(() => writeManifest({ version: 1, packages: [{ source: "npm:pi-lens" }] }), /not pinned/);
assert.throws(
	() => writeManifest({ version: 1, packages: [{ source: "git:github.com/u/r" }] }),
	/not pinned/,
);

// A local path is one machine's path; it cannot be a fleet's desired state.
assert.throws(() => writeManifest({ version: 1, packages: [{ source: "/srv/pkg" }] }), /by hand/);

// Two entries for one package are two answers to one question, and
// reconciliation would install whichever came last on every pass.
assert.throws(
	() =>
		writeManifest({
			version: 1,
			packages: [{ source: "npm:pi-lens@4.2.0" }, { source: "npm:pi-lens@4.2.1" }],
		}),
	/listed twice/,
);
// Identity ignores the transport, so these ARE the same package.
assert.throws(
	() =>
		writeManifest({
			version: 1,
			packages: [
				{ source: "git:git@github.com:u/r@v1" },
				{ source: "https://github.com/u/r@v2" },
			],
		}),
	/listed twice/,
);

// A rejected write leaves the stored manifest untouched: a typo in the
// editor must not empty the fleet's desired state.
assert.deepEqual(readManifest(), saved, "a refused write changes nothing");

// ---------------------------------------------------------------------------
// Reading what is there
// ---------------------------------------------------------------------------
// Hand-edited and broken: reconciling to "nothing" is the safe reading,
// because the alternative is acting on half a file.
writeFileSync(file, "{ not json");
assert.deepEqual(readManifest(), { version: 1, packages: [] });

writeFileSync(file, JSON.stringify({ version: 1, packages: [{ source: "npm:x@1" }, "junk", {}] }));
assert.deepEqual(readManifest().packages, [{ source: "npm:x@1" }], "unreadable entries are skipped");

// ---------------------------------------------------------------------------
// Adopting
// ---------------------------------------------------------------------------
writeManifest({ version: 1, packages: [{ source: "npm:pi-lens@4.2.1" }] });

// An unmanaged package is adopted at the version it is actually running —
// the only honest pin available for something already installed.
const adopted = adopt("npm:pi-mcp-adapter", "2.34.0");
assert.deepEqual(adopted.packages, [
	{ source: "npm:pi-lens@4.2.1" },
	{ source: "npm:pi-mcp-adapter@2.34.0" },
]);

// Already pinned: adopted as written, not re-pinned to what happens to be
// on this one machine.
assert.deepEqual(adopt("git:github.com/u/r@v9", null).packages.at(-1), {
	source: "git:github.com/u/r@v9",
});

// Nothing to pin to, and nothing installed to read a version from.
assert.throws(() => adopt("npm:never-installed", null), /no version to pin/);

// The file on disk is the one the next reconcile reads, so it has to be the
// one the API just answered with.
assert.deepEqual(
	JSON.parse(readFileSync(file, "utf8")),
	{
		version: 1,
		packages: [
			{ source: "npm:pi-lens@4.2.1" },
			{ source: "npm:pi-mcp-adapter@2.34.0" },
			{ source: "git:github.com/u/r@v9" },
		],
	},
	"every accepted write lands on disk",
);

console.log("ok");
