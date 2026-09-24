/**
 * git.test.ts — the porcelain and log parses, in a throwaway repo.
 *
 * Only the PARSING is covered; everything else here is git doing its own job.
 * Two bugs live in these parses and neither one crashes:
 *
 * - status output is trimmed on the way in, so the first entry loses its
 *   leading space and a fixed `slice(3)` silently ate a character of exactly
 *   one filename per call. That diffs a path that does not exist and reports
 *   the file as empty, which looks like "no changes".
 * - `-z` emits a RENAME as two tokens, so a parser that reads one token per
 *   entry shifts every subsequent path by one and attributes files to the
 *   wrong commit.
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changes, log, show } from "./git.js";

const dir = mkdtempSync(join(tmpdir(), "pwi-git-"));
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });

try {
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(dir, "tracked.txt"), "one\n");
	writeFileSync(join(dir, "second.txt"), "a\n");
	git("add", "-A");
	git("commit", "-qm", "init");

	writeFileSync(join(dir, "tracked.txt"), "two\n");
	writeFileSync(join(dir, "second.txt"), "b\n");
	writeFileSync(join(dir, "fresh.txt"), "new\n");

	// --- changes ---------------------------------------------------------
	const listed = await changes(dir);
	assert.equal(listed.length, 3, "modified, modified and untracked");
	// The real regression: every path round-trips whole, including the first
	// one, whose status column arrives one character short.
	assert.deepEqual(
		listed.map((f) => f.path).sort(),
		["fresh.txt", "second.txt", "tracked.txt"],
	);
	assert.equal(listed.find((f) => f.path === "fresh.txt")?.status.trim(), "??");

	// --- show, working tree ----------------------------------------------
	const tracked = await show(dir, "tracked.txt");
	assert.equal(tracked.before, "one\n");
	assert.equal(tracked.after, "two\n");

	// Untracked: nothing in HEAD, so "" is the honest before-image.
	const fresh = await show(dir, "fresh.txt");
	assert.equal(fresh.before, "");
	assert.equal(fresh.after, "new\n");

	// Deleted on disk: still listed, with an empty after rather than dropped.
	rmSync(join(dir, "second.txt"));
	assert.ok((await changes(dir)).some((f) => f.path === "second.txt"));
	const gone = await show(dir, "second.txt");
	assert.equal(gone.before, "a\n");
	assert.equal(gone.after, "");

	// Not a repo at all is a clean [], not a throw: the panel asks about
	// whatever directory is on screen.
	assert.deepEqual(await changes(tmpdir()), []);

	// --- log ---------------------------------------------------------------
	git("add", "-A");
	git("commit", "-qm", "second commit");
	// A rename is the two-token case the -z scan has to survive, plus a file
	// with a SPACE in its name, which is why -z is used at all.
	git("mv", "tracked.txt", "renamed file.txt");
	git("commit", "-qm", "third commit");

	const commits = await log(dir);
	assert.equal(commits.length, 3);
	assert.deepEqual(
		commits.map((c) => c.subject),
		["third commit", "second commit", "init"],
	);
	assert.match(commits[0].hash, /^[0-9a-f]{40}$/);
	assert.equal(commits[0].author, "t");

	// The rename lands on the RIGHT commit, as its destination path, and does
	// not push the next commit's files out by one.
	assert.deepEqual(
		commits[0].files.map((f) => f.path),
		["renamed file.txt"],
	);
	assert.match(commits[0].files[0].status, /^R/);
	assert.deepEqual(
		commits[1].files.map((f) => f.path).sort(),
		["fresh.txt", "second.txt", "tracked.txt"],
	);
	// The ROOT commit still reports its files: it has no parent, which is the
	// case a `sha^` diff has to tolerate rather than drop.
	assert.deepEqual(
		commits[2].files.map((f) => f.path).sort(),
		["second.txt", "tracked.txt"],
	);

	// --- show, at a commit -------------------------------------------------
	const atSecond = await show(dir, "tracked.txt", commits[1].hash);
	assert.equal(atSecond.before, "one\n");
	assert.equal(atSecond.after, "two\n");

	// A root commit has no parent: the before side is empty and the file reads
	// as wholly added, rather than the call failing.
	const atRoot = await show(dir, "tracked.txt", commits[2].hash);
	assert.equal(atRoot.before, "");
	assert.equal(atRoot.after, "one\n");

	// A ref that is not a sha never reaches git: the path is user input from a
	// query string, and `show` is the one place a ref crosses into argv.
	await assert.rejects(() => show(dir, "tracked.txt", "HEAD; rm -rf /"));

	console.log("git.test.ts ok");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
