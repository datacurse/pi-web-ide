// Run: node --import tsx src/server/sessions.test.ts
//
// Fixtures are real JSONL files in a temp dir with PWI_SESSION_ROOT pointed at
// it, because every interesting behaviour here is a filesystem behaviour: the
// cwd-vs-directory-name mismatch, a torn trailing line, mtime ordering.
import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessions, sameProject, sessionHeaderCwd } from "./sessions.js";

// Set after the import on purpose: listSessions reads PWI_SESSION_ROOT on every
// call, so there is no load-order coupling to get wrong here.
const tmp = mkdtempSync(join(tmpdir(), "pwi-sessions-"));
process.env.PWI_SESSION_ROOT = join(tmp, "sessions");

const projectA = join(tmp, "alpha");
const projectB = join(tmp, "beta");
mkdirSync(projectA);
mkdirSync(projectB);

interface Fixture {
	/** Directory under the session root — deliberately arbitrary. */
	dir: string;
	uuid: string;
	cwd: string;
	/** Written as a `session_info` entry, the way `set_session_name` does. */
	title?: string;
	/** Seconds since epoch; sets mtime, which must NOT decide the order. */
	mtime: number;
	/** `session.timestamp`, the one timestamp that never moves. */
	created: string;
	lines: string[];
	/** Appended verbatim with no trailing newline, simulating a live write. */
	torn?: string;
}

function write(f: Fixture): string {
	const dir = join(process.env.PWI_SESSION_ROOT as string, f.dir);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${f.created.replace(/[:.]/g, "-")}_${f.uuid}.jsonl`);
	const head = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: f.uuid,
			timestamp: f.created,
			cwd: f.cwd,
		}),
	];
	// A name is a `session_info` entry appended after the fact, exactly as
	// `set_session_name` writes one.
	const tail = f.title ? [JSON.stringify({ type: "session_info", id: "s1", name: f.title })] : [];
	writeFileSync(file, `${[...head, ...f.lines, ...tail].join("\n")}\n${f.torn ?? ""}`);
	utimesSync(file, f.mtime, f.mtime);
	return file;
}

const userMsg = (text: string, image = false, timestamp = "2026-09-14T10:00:05.000Z") =>
	JSON.stringify({
		type: "message",
		id: "u1",
		timestamp,
		message: {
			role: "user",
			content: image
				? [{ type: "image", data: "AAA", mimeType: "image/png" }, { type: "text", text }]
				: [{ type: "text", text }],
			attribution: "user",
		},
	});

const assistantMsg = (timestamp = "2026-09-14T10:00:09.000Z") =>
	JSON.stringify({
		type: "message",
		id: "a1",
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text: "sure" }] },
	});

// Non-message entry types must not inflate messageCount.
const noise = [
	JSON.stringify({ type: "model_change", id: "m", model: "anthropic/claude-opus-5" }),
	JSON.stringify({ type: "thinking_level_change", id: "t", level: "medium" }),
	JSON.stringify({ type: "compaction", id: "k", summary: "folded" }),
];

/*
 * The three timestamps are deliberately in DIFFERENT orders, because the bug
 * this pins was a list ordered by the only one that is not conversation:
 *
 *   created  (header):     torn > misfiled > oldest
 *   lastActive (messages): oldest > torn > misfiled
 *   mtime (file):          misfiled > torn > oldest   ← must decide nothing
 */

// (a) Attribution is by the header cwd, never the directory name: this file
// lives in a directory named after project B but belongs to project A.
const misfiled = write({
	dir: "-this-name-is-a-lie",
	uuid: "00000000-0000-0000-0000-00000000000a",
	cwd: projectA,
	created: "2026-09-14T09:00:00.000Z",
	mtime: 3000,
	lines: [
		userMsg("first words", false, "2026-09-14T09:00:05.000Z"),
		...noise,
		assistantMsg("2026-09-14T09:00:09.000Z"),
		// Renamed twice. pi appends one `session_info` per rename instead of
		// rewriting a slot, so a reader that took the first would show the name
		// this session used to have.
		JSON.stringify({ type: "session_info", id: "s1", name: "misfiled but mine" }),
		JSON.stringify({ type: "session_info", id: "s2", name: "renamed once more" }),
	],
});

// (b) A live session whose last line is half-written.
const torn = write({
	dir: "-alpha-2",
	uuid: "00000000-0000-0000-0000-00000000000b",
	cwd: projectA,
	created: "2026-09-14T11:00:00.000Z",
	mtime: 2000,
	lines: [
		userMsg("  padded and very  ", true, "2026-09-14T11:00:05.000Z"),
		assistantMsg("2026-09-14T11:10:00.000Z"),
	],
	torn: '{"type":"message","id":"a2","message":{"role":"assis',
});

// Oldest by creation, newest by activity: an old session picked back up.
const oldest = write({
	dir: "-alpha-3",
	uuid: "00000000-0000-0000-0000-00000000000c",
	cwd: projectA,
	title: "oldest",
	created: "2026-09-13T08:00:00.000Z",
	mtime: 1000,
	lines: [userMsg("older", false, "2026-09-16T12:00:00.000Z")],
});

const otherProject = write({
	dir: "-beta",
	uuid: "00000000-0000-0000-0000-00000000000d",
	cwd: projectB,
	created: "2026-09-14T12:00:00.000Z",
	mtime: 9000,
	lines: [userMsg("not yours")],
});

// A file with no session header at all cannot be attributed to any project.
const headerless = join(process.env.PWI_SESSION_ROOT as string, "-alpha-4", "orphan.jsonl");
mkdirSync(join(process.env.PWI_SESSION_ROOT as string, "-alpha-4"), { recursive: true });
writeFileSync(headerless, `${userMsg("orphan")}\n`);

const a = await listSessions(projectA);

// (a) + (c): exactly project A's three sessions, newest CREATED first — which
// is neither the mtime order nor the activity order of these fixtures.
assert.deepEqual(
	a.map((s) => s.path),
	[torn, misfiled, oldest],
	"filtered by header cwd, ordered newest-created-first",
);
assert(!a.some((s) => s.path === otherProject), "another project's session is not listed");
assert(!a.some((s) => s.path === headerless), "a session with no cwd header is not listed");

// The other sort mode the UI offers, from the same payload: last message
// first. `oldest` is last by creation and first by activity, so an
// implementation that reported mtime (or the last LINE) could not produce it.
assert.deepEqual(
	[...a].sort((x, y) => y.lastActive.localeCompare(x.lastActive)).map((s) => s.path),
	[oldest, torn, misfiled],
	"lastActive orders by conversation, not by file",
);

// (b) The torn session survives with its intact lines counted.
const tornInfo = a[0];
assert.equal(tornInfo.messageCount, 2, "torn trailing line is skipped, not counted");
assert.equal(tornInfo.firstMessage, "padded and very", "first text block, trimmed");
assert.equal(tornInfo.name, undefined, "a session nobody named has no name");
assert.equal(tornInfo.lastActive, "2026-09-14T11:10:00.000Z", "last message, not last line");

// Noise entries are not messages, and the LAST `session_info` is the live
// name: pi appends one per rename rather than rewriting a slot, so a reader
// that took the first would show the name the session used to have.
assert.equal(a[1].messageCount, 2, "only message entries count");
assert.equal(a[1].name, "renamed once more", "the last session_info wins");
assert.equal(a[1].id, "00000000-0000-0000-0000-00000000000a", "id from the session header");
assert.equal(a[1].created, "2026-09-14T09:00:00.000Z", "created from session.timestamp");
assert.equal(a[1].lastActive, "2026-09-14T09:00:09.000Z", "lastActive from the last message");

// A cwd reached through a symlink is the same project.
const link = join(tmp, "alpha-link");
symlinkSync(projectA, link);
assert.deepEqual(
	(await listSessions(link)).map((s) => s.path),
	a.map((s) => s.path),
	"symlinked cwd resolves to the same project",
);

// A deleted project must answer empty rather than throw on realpath.
assert.deepEqual(await listSessions(join(tmp, "gone")), [], "missing cwd lists nothing");

/*
 * THE REGRESSION. Resuming a session appends bookkeeping rows — pi writes a
 * `model_change` and a `thinking_level_change` on every start — so the file
 * grows and its mtime jumps while the conversation stands still. That used to
 * move the session to the top of the list and relabel it "just now" with an
 * unchanged message count.
 */
appendFileSync(
	oldest,
	`${JSON.stringify({
		type: "thinking_level_change",
		id: "tl1",
		timestamp: "2026-09-17T23:59:00.000Z",
		level: "off",
	})}\n`,
);
utimesSync(oldest, 8000, 8000);
const resumed = await listSessions(projectA);
assert.deepEqual(
	resumed.map((s) => s.path),
	[torn, misfiled, oldest],
	"a resume does not reorder the list",
);
const resumedOldest = resumed.find((s) => s.path === oldest);
assert.equal(resumedOldest?.messageCount, 1, "a bookkeeping row is not a message");
assert.equal(
	resumedOldest?.lastActive,
	"2026-09-16T12:00:00.000Z",
	"a resume does not count as activity",
);

// A growing session is re-read: the memo is keyed on size+mtime, not path.
appendFileSync(oldest, `${assistantMsg("2026-09-18T09:00:00.000Z")}\n`);
utimesSync(oldest, 4000, 4000);
const grown = await listSessions(projectA);
const grownOldest = grown.find((s) => s.path === oldest);
assert.equal(grownOldest?.messageCount, 2, "appended message invalidates the memo");
assert.equal(
	grownOldest?.lastActive,
	"2026-09-18T09:00:00.000Z",
	"a real message does move lastActive",
);
assert.equal(grown[0].path, torn, "created order is unaffected by new activity");

assert.equal(await sessionHeaderCwd(misfiled), projectA, "header cwd read back");
assert.equal(await sessionHeaderCwd(headerless), undefined, "no header, no cwd");
assert.equal(await sessionHeaderCwd(join(tmp, "nope.jsonl")), undefined, "missing file, no cwd");

// sessionHeaderCwd stops at the header, so its result must never be cached:
// doing so would make the next list report zero messages. Invalidate the memo
// first (mtime only, same bytes) so the header-only path is really taken.
utimesSync(misfiled, 5000, 5000);
await sessionHeaderCwd(misfiled);
assert.equal(
	(await listSessions(projectA))[0].messageCount,
	2,
	"header-only read does not poison the memo",
);

// sameProject decides whether the open route serves a session to the project
// that asked for it, and a false negative costs the user a tab: a session
// recorded through a symlinked cwd, or one whose project has since been
// deleted, must still be recognised as its own.
assert.equal(await sameProject(link, projectA), true, "symlinked project is the same project");
assert.equal(await sameProject(projectA, `${projectA}/`), true, "trailing slash is the same project");
assert.equal(await sameProject(projectA, projectB), false, "sibling projects are distinct");
const gone = join(tmp, "gone");
assert.equal(await sameProject(gone, gone), true, "a deleted project still matches itself");

console.log("ok");
