// Run: node --import tsx src/server/packages.test.ts
//
// Source parsing and the API's refusals. Both are load-bearing: identity is
// what makes one row of the Packages table mean "the same package on three
// machines", and validation is the gate in front of a process spawn.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { list, parseSource, validate } from "./packages.js";

// Set after the import on purpose: both paths are resolved per call, so
// there is no load-order coupling to get wrong — same as sessions.test.ts.
const dir = mkdtempSync(join(tmpdir(), "pwi-packages-"));
process.env.PWI_PI_SETTINGS = join(dir, "settings.json");
process.env.PI_CODING_AGENT_DIR = dir;

// ---------------------------------------------------------------------------
// The `@` problem
//
// A source can carry an ssh user AND a ref, both spelled with `@`. Picking
// the wrong one turns `git:git@github.com:user/repo` into a package named
// `git` pinned to `github.com:user/repo`.
// ---------------------------------------------------------------------------
const pin = (s: string) => {
	const p = parseSource(s);
	return p && { kind: p.kind, identity: p.identity, pinned: p.pinned };
};

assert.deepEqual(pin("npm:pi-lens"), { kind: "npm", identity: "pi-lens", pinned: null });
assert.deepEqual(pin("npm:pi-lens@1.4.2"), { kind: "npm", identity: "pi-lens", pinned: "1.4.2" });
// A scope is an `@` that is NOT a version.
assert.deepEqual(pin("npm:@335g/pi-autocommit"), {
	kind: "npm",
	identity: "@335g/pi-autocommit",
	pinned: null,
});
assert.deepEqual(pin("npm:@335g/pi-autocommit@0.3.0"), {
	kind: "npm",
	identity: "@335g/pi-autocommit",
	pinned: "0.3.0",
});

// git: identity is the repo without its ref, and the transport is not part of
// it — the same repo over ssh and over https is one package, which is what
// lets the fleet table put it on one row.
const repo = { kind: "git", identity: "github.com/datacurse/pi-config" };
assert.deepEqual(pin("git:github.com/datacurse/pi-config"), { ...repo, pinned: null });
assert.deepEqual(pin("git:github.com/datacurse/pi-config@v3"), { ...repo, pinned: "v3" });
assert.deepEqual(pin("git:git@github.com:datacurse/pi-config"), { ...repo, pinned: null });
assert.deepEqual(pin("git:git@github.com:datacurse/pi-config@v3"), { ...repo, pinned: "v3" });
assert.deepEqual(pin("https://github.com/datacurse/pi-config"), { ...repo, pinned: null });
assert.deepEqual(pin("https://github.com/datacurse/pi-config.git"), { ...repo, pinned: null });
assert.deepEqual(pin("ssh://git@github.com/datacurse/pi-config@v3"), { ...repo, pinned: "v3" });

// A port is not a path separator: `host:2222/team/pkg` keeps its port, while
// `host:team/pkg` is the scp-like form and its colon IS the separator.
assert.equal(
	parseSource("ssh://git@git.example.com:2222/team/pkg")?.identity,
	"git.example.com:2222/team/pkg",
);

assert.equal(parseSource("/srv/pkgs/local")?.kind, "local");
assert.equal(parseSource("./relative")?.kind, "local");
assert.equal(parseSource("just-a-word"), null, "a bare word names no source pi understands");
assert.equal(parseSource("   "), null);

// ---------------------------------------------------------------------------
// What the API will and will not spawn a process for
// ---------------------------------------------------------------------------
assert.equal(validate("npm:pi-lens@1.4.2").source, "npm:pi-lens@1.4.2");
assert.equal(validate("git:github.com/u/r@v1").identity, "github.com/u/r");

// A local path is meaningful on exactly one machine, and accepting one from
// a browser is a path-traversal surface for no benefit.
assert.throws(() => validate("/etc/passwd"), /by hand/);
assert.throws(() => validate("../../etc"), /by hand/);

// Nothing here can reach a shell — every mutation spawns pi with an args
// array — but a source that looks like an injection is still a typo at best,
// and refusing it beats spawning a process to be told no.
assert.throws(() => validate("rm -rf /"), /not a package source/);
assert.throws(() => validate("npm:Not Valid"), /not an npm package name/);
assert.throws(() => validate("npm:pkg@1.0.0;rm -rf"), /not an npm version/);
// A trailing slash puts the last `/` after the last `@`, so there is no ref
// to split and the whole string has to fail as a name instead.
assert.throws(() => validate("npm:pkg@1.0.0; rm -rf /"), /not an npm package name/);
assert.throws(() => validate("git:github.com/u/r@$(id)"), /not a git ref/);

// ---------------------------------------------------------------------------
// Reading pi's settings
//
// The array may be absent, entries may be strings or objects, and an entry
// may be something no version of this code understands. None of those is a
// reason to fail the whole list — this list is also how a broken settings
// file becomes visible.
// ---------------------------------------------------------------------------
assert.deepEqual(await list(), [], "no settings file at all is an empty list");

writeFileSync(process.env.PWI_PI_SETTINGS, JSON.stringify({ theme: "dark" }));
assert.deepEqual(await list(), [], "settings without a packages key is an empty list");

writeFileSync(
	process.env.PWI_PI_SETTINGS,
	JSON.stringify({
		packages: [
			"npm:pi-sub-anthropic",
			{ source: "npm:pi-lens", autoload: false },
			{ source: "npm:pi-web-access", skills: [], extensions: ["dist/*.js"] },
			{ notASource: true },
			"nonsense",
			42,
		],
	}),
);
const listed = await list();
assert.deepEqual(
	listed.map((p) => p.identity),
	["pi-sub-anthropic", "pi-lens", "pi-web-access"],
	"unparseable entries are skipped, the rest survive",
);
assert.equal(listed[0].autoload, true, "a bare string autoloads");
assert.equal(listed[1].autoload, false, "autoload: false is reported");
assert.equal(listed[1].filtered, false, "autoload is not a resource filter");
assert.equal(listed[2].filtered, true, "resource keys mark a package as partially loaded");
assert.equal(listed[0].installed, null, "nothing is on disk in this temp agent dir");

console.log("ok");
