/**
 * git.ts — the four git actions worth having in a chat window.
 *
 * An agent session ends with a working tree full of changes, and the next
 * thing anybody does is commit them. From a browser on another machine there
 * is no terminal to do it in — and now there is one (terminals.ts), but
 * typing `git add -A && git commit -m …` by hand on a phone is not the point.
 *
 * Deliberately NOT a git client. No staging UI, no hunks, no log, no merge
 * tools: those are a real application, and pwi already has a terminal for the
 * cases this does not cover. What is here is the end of an agent turn —
 * branch, commit, push, PR — composed from four independent steps, because
 * every combination anybody actually asks for (`Commit`, `Commit & Push`,
 * `Create Branch, Commit & Push`, `Commit & Create PR`) is a subset of those
 * four in that order.
 *
 * Three lines have since moved: `changes()`, `show()` and `log()` serve a
 * READ-ONLY source-control panel. That is still not a git client — nothing
 * there stages, reverts, rebases or edits history, it is `git status`, `git
 * show` and `git log` rendered legibly — but it is worth being honest that
 * the "no log, no diff viewer" rule above now has exactly those exceptions,
 * and that STAGING is where the line was redrawn: a commit here is always
 * `add -A`, so there is no index to present.
 *
 * Every invocation is `execFile` with an argv array and no shell: a commit
 * message is arbitrary user text, and a shell would make `"; rm -rf ~"` a
 * commit message that means something else.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Long enough for a push over a slow link, short enough to fail visibly. */
const GIT_TIMEOUT_MS = 120_000;

/** A commit message is one paragraph, not a file. */
const MAX_MESSAGE_BYTES = 8_000;

export interface GitStatus {
	repo: boolean;
	branch: string;
	/** Files with staged, unstaged or untracked changes — the commit's size. */
	changed: number;
	/** Commits this branch has that its upstream does not, and vice versa. */
	ahead: number;
	behind: number;
	/** Empty when the branch has no upstream: the first push has to set one. */
	upstream: string;
	/** Empty when the repo has no remote at all, in which case push is a no-op. */
	remote: string;
	/** Whether `gh` is on PATH; without it, "create PR" cannot work. */
	gh: boolean;
}

/** One step of a plan, in the order they are always applied. */
export interface GitPlan {
	/** Create and switch to this branch first. */
	branch?: string;
	/** Stage everything and commit with this message. */
	message?: string;
	push?: boolean;
	pr?: boolean;
}

export interface GitResult {
	ok: boolean;
	/** What each step printed, in order, for the transcript-side notice. */
	steps: Array<{ step: string; output: string }>;
	/** Set when a step failed; later steps are NOT attempted. */
	error?: string;
	/** The PR URL, when one was created. */
	url?: string;
}

/**
 * `raw` keeps stdout byte-for-byte. Everything here wants it trimmed — a
 * branch name with a newline on it is noise in every caller — except FILE
 * CONTENT from `git show`, where the trailing newline is part of the file and
 * eating it makes the merge view report a change on the last line of every
 * diff.
 */
function run(
	cwd: string,
	file: string,
	args: string[],
	raw = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const { promise, resolve } = Promise.withResolvers<{
		code: number;
		stdout: string;
		stderr: string;
	}>();
	execFile(
		file,
		args,
		{ cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
		(err, stdout, stderr) => {
			// A non-zero exit is data here, not an exception: `git commit` with
			// nothing staged is the most common outcome of clicking Commit twice,
			// and it has to read as a message rather than as a crash.
			const code = err && typeof err === "object" && "code" in err ? Number(err.code) : err ? 1 : 0;
			resolve({
				code,
				stdout: raw ? String(stdout) : String(stdout).trim(),
				stderr: String(stderr).trim(),
			});
		},
	);
	return promise;
}

const git = (cwd: string, args: string[], raw = false) => run(cwd, "git", args, raw);

async function has(cwd: string, file: string): Promise<boolean> {
	// `command -v` through a shell would be shorter and would also inherit the
	// shell's own PATH surprises; asking the binary directly is the check that
	// matches how it will actually be spawned.
	const probe = await run(cwd, file, ["--version"]).catch(() => null);
	return !!probe && probe.code === 0;
}

/**
 * What the button can offer, and what it should say.
 *
 * Read fresh on every request rather than cached: the tree changes under this
 * constantly — that is the whole point of the agent running in it — and a
 * cached "3 files changed" is worse than no count at all.
 */
export async function status(cwd: string): Promise<GitStatus> {
	const empty: GitStatus = {
		repo: false,
		branch: "",
		changed: 0,
		ahead: 0,
		behind: 0,
		upstream: "",
		remote: "",
		gh: false,
	};
	if (!(existsSync(cwd) && statSync(cwd).isDirectory())) return empty;

	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout !== "true") return empty;

	const [branch, porcelain, upstream, remote, gh] = await Promise.all([
		git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
		git(cwd, ["status", "--porcelain"]),
		git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
		git(cwd, ["remote"]),
		has(cwd, "gh"),
	]);

	// `--porcelain` lists one path per line, so the line count IS the number of
	// changed paths — no parse needed, and it counts untracked files too, which
	// `git add -A` will commit.
	const changed = porcelain.stdout ? porcelain.stdout.split("\n").length : 0;

	let ahead = 0;
	let behind = 0;
	if (upstream.code === 0) {
		const counts = await git(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
		const [b, a] = counts.stdout.split(/\s+/).map(Number);
		behind = Number.isFinite(b) ? b : 0;
		ahead = Number.isFinite(a) ? a : 0;
	}

	return {
		repo: true,
		branch: branch.code === 0 ? branch.stdout : "",
		changed,
		ahead,
		behind,
		upstream: upstream.code === 0 ? upstream.stdout : "",
		remote: remote.stdout.split("\n")[0] ?? "",
		gh,
	};
}

/**
 * A starting point for the commit message, computed locally and instantly.
 *
 * A SUMMARY of the diff and not a generated sentence: it is what the box is
 * prefilled with on every open, so it has to cost nothing and never fail.
 * The model-written version is one click away (`nameCommit` in autoname.ts)
 * for when the file list is not enough — which is most of the time, but not
 * at the speed a placeholder has to appear.
 */
export async function suggestMessage(cwd: string): Promise<string> {
	const stat = await git(cwd, ["status", "--porcelain"]);
	const files = stat.stdout
		.split("\n")
		.filter(Boolean)
		/*
		 * The status code is two columns and then whitespace — but the output is
		 * trimmed on the way in, so the FIRST line of an unstaged change comes
		 * back as `M a.txt` and not ` M a.txt`. A fixed `slice(3)` therefore ate
		 * a character of the first filename (`Update .txt`); this matches either
		 * shape. A rename reads `R old -> new`, and the new path is the one the
		 * commit is about.
		 */
		.map((line) => line.replace(/^.{0,2}\s+/, "").split(" -> ").at(-1) ?? "")
		.filter(Boolean);
	if (files.length === 0) return "";
	if (files.length === 1) return `Update ${files[0]}`;

	const shown = files.slice(0, 3).join(", ");
	const rest = files.length - Math.min(3, files.length);
	return `Update ${shown}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/**
 * How much of the diff the naming model is shown.
 *
 * 20 kB is roughly the point where a commit message stops improving: the
 * first hunks of a change say what it is, and a 56-file tree would otherwise
 * send a megabyte of patch to describe itself in eight words.
 */
const MAX_DIFF_BYTES = 20_000;

/**
 * What changed, as text to hand a model. Empty when the tree is clean.
 *
 * Three views, cheapest first: the status list (the only one that mentions
 * UNTRACKED files, which `git add -A` will commit and `git diff` will not
 * show), the diffstat, and as much of the patch as fits. On a repo with no
 * commits yet `git diff HEAD` has no HEAD to diff against, so the patch is
 * simply absent and the file list carries the message.
 */
export async function changeSummary(cwd: string): Promise<string> {
	const [status, stat, patch] = await Promise.all([
		git(cwd, ["status", "--porcelain"]),
		git(cwd, ["diff", "HEAD", "--stat"]),
		git(cwd, ["diff", "HEAD"]),
	]);
	if (!status.stdout) return "";

	const parts = [`Changed files:\n${status.stdout}`];
	if (stat.code === 0 && stat.stdout) parts.push(`Diffstat:\n${stat.stdout}`);
	if (patch.code === 0 && patch.stdout) {
		const body =
			patch.stdout.length > MAX_DIFF_BYTES
				? `${patch.stdout.slice(0, MAX_DIFF_BYTES)}\n… diff truncated`
				: patch.stdout;
		parts.push(`Diff:\n${body}`);
	}
	return parts.join("\n\n");
}

/** One changed path, as the source-control panel lists it. */
export interface GitChange {
	path: string;
	/** Porcelain status letters, e.g. ` M`, `??`, `A `. */
	status: string;
}

/** One file's two sides, for the merge view a diff tab renders. */
export interface GitFileDiff {
	path: string;
	/** The older side; "" for something untracked or added in that commit. */
	before: string;
	/** The newer side; "" when the file has been deleted. */
	after: string;
	/** Set when the content was too big to send, instead of the text. */
	skipped?: string;
}

/** One commit, with the paths it touched. */
export interface GitCommit {
	hash: string;
	subject: string;
	author: string;
	/** Relative, as git formats it: "2 hours ago". */
	when: string;
	files: GitChange[];
}

/** Bigger than this and the tab gets a note instead of two copies of it. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Which paths differ from HEAD, and how. NAMES ONLY.
 *
 * The content of each side is a separate request (`show` below) because the
 * panel that asks this renders a LIST: shipping both copies of every changed
 * file to draw twelve rows was megabytes to render a sidebar, and the diff
 * itself is opened one file at a time.
 *
 * `git status --porcelain` drives it rather than `git diff --name-only`,
 * because only status mentions UNTRACKED files — a file the agent just created
 * is the single most likely thing to want to look at, and `git diff` does not
 * know it exists.
 */
export async function changes(cwd: string): Promise<GitChange[]> {
	if (!(existsSync(cwd) && statSync(cwd).isDirectory())) return [];
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout !== "true") return [];

	const porcelain = await git(cwd, ["status", "--porcelain", "-z"]);
	if (!porcelain.stdout) return [];

	// -z because a path with a space or a newline in it is legal, and the
	// line-based format quotes those into something that has to be unescaped.
	const entries = porcelain.stdout.split("\0").filter(Boolean);
	const out: GitChange[] = [];

	for (let i = 0; i < entries.length; i++) {
		/*
		 * NOT a fixed slice(3). stdout is trimmed on the way in, so the FIRST
		 * entry of an unstaged change arrives as `M src/x.ts` and not
		 * ` M src/x.ts` — a fixed offset ate a character of that one filename
		 * (`rc/server/index.ts`) and then diffed a file that does not exist.
		 * Same shape-tolerant split as suggestMessage above.
		 */
		const m = /^(.{1,2})\s+(.*)$/s.exec(entries[i]);
		if (!m) continue;
		const status = m[1].padEnd(2);
		// A rename or copy is TWO -z tokens: `R  old` and then the destination
		// on its own. The destination is the path that has content to show.
		const path = /[RC]/.test(status) && entries[i + 1] ? entries[++i] : m[2];
		if (path) out.push({ status, path });
	}

	return out;
}

/** A commit this server will pass to `git show`. Anything else is refused. */
const SHA = /^[0-9a-f]{4,40}$/i;

/**
 * One file's before/after, either for a commit or for the working tree.
 *
 * Two documents and not a unified patch: the tab renders with CodeMirror's
 * merge view, which takes two documents. Letting git produce a patch and then
 * parsing it back into two documents would be work to undo work.
 *
 * `ref` empty means the working tree — HEAD against what is on disk, which is
 * the only pair that includes edits nobody has committed. A commit sha means
 * `sha^` against `sha`; a root commit has no parent, so the before side is
 * simply empty and the whole file reads as added.
 */
export async function show(cwd: string, path: string, ref = ""): Promise<GitFileDiff> {
	if (ref && !SHA.test(ref)) throw new Error(`not a commit: ${ref}`);

	if (ref) {
		// raw: this is file content, not a git answer. See `run`.
		const [before, after] = await Promise.all([
			git(cwd, ["show", `${ref}^:${path}`], true),
			git(cwd, ["show", `${ref}:${path}`], true),
		]);
		return {
			path,
			// A non-zero exit is "not in that tree", which is the normal answer
			// for a file the commit added (no before) or deleted (no after).
			before: before.code === 0 ? before.stdout : "",
			after: after.code === 0 ? after.stdout : "",
		};
	}

	// `git show` rather than reading .git ourselves: it resolves HEAD and
	// renames correctly. A non-zero exit means the file is not in HEAD, the
	// normal answer for something newly created.
	const head = await git(cwd, ["show", `HEAD:${path}`], true);
	const before = head.code === 0 ? head.stdout : "";
	try {
		const full = join(cwd, path);
		const st = statSync(full);
		if (st.size > MAX_FILE_BYTES)
			return { path, before: "", after: "", skipped: `too large to diff (${st.size} bytes)` };
		return { path, before, after: readFileSync(full, "utf8") };
	} catch {
		// Deleted, or not readable: "" is the honest after-image of a file that
		// is no longer there.
		return { path, before, after: "" };
	}
}

/** Field separator inside one commit's header line. */
const FS = "\x1f";

/**
 * The last `limit` commits on HEAD, each with its changed paths.
 *
 * One `git log` and not one per commit: the panel draws a collapsible tree,
 * and a request per row would be fifty round trips to render a list nobody
 * has expanded yet.
 *
 * `-z` makes every file entry NUL-separated, so a path with a space or a
 * newline in it survives; the commit headers are then the tokens carrying the
 * field separator, which is what tells the two apart while scanning.
 */
export async function log(cwd: string, limit = 50): Promise<GitCommit[]> {
	const out = await git(cwd, [
		"log",
		`-n${Math.max(1, Math.min(500, limit))}`,
		"-z",
		"--name-status",
		`--format=%H${FS}%s${FS}%an${FS}%ar`,
	]);
	if (out.code !== 0 || !out.stdout) return [];

	const commits: GitCommit[] = [];
	const tokens = out.stdout.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		// A header is the only token with field separators in it. It arrives with
		// the previous commit's trailing newline stuck to its front.
		const token = tokens[i].replace(/^\n/, "");
		if (!token) continue;
		if (token.includes(FS)) {
			const [hash, subject, author, when] = token.split(FS);
			commits.push({ hash, subject, author, when, files: [] });
			continue;
		}
		const commit = commits.at(-1);
		// A status token is followed by its path; a rename by two paths, of
		// which the destination is the one that exists in this commit.
		if (!commit || !/^[A-Z]/.test(token)) continue;
		const renamed = /^[RC]/.test(token);
		const path = tokens[renamed ? i + 2 : i + 1];
		i += renamed ? 2 : 1;
		if (path) commit.files.push({ status: token, path });
	}
	return commits;
}

/**
 * Run a plan, stopping at the first failure.
 *
 * Stopping is the whole contract: pushing a branch whose commit failed, or
 * opening a PR for a push that did not land, produces a state nobody asked
 * for and that the UI would then have to explain. Each step's output is
 * returned so the notice in the transcript can say what actually happened
 * rather than "done".
 */
export async function apply(cwd: string, plan: GitPlan): Promise<GitResult> {
	const steps: GitResult["steps"] = [];
	const fail = (error: string): GitResult => ({ ok: false, steps, error });

	const state = await status(cwd);
	if (!state.repo) return fail(`not a git repository: ${cwd}`);

	if (plan.branch) {
		const name = plan.branch.trim();
		// Rejected here rather than by git, because git's own message for a bad
		// ref name is a wall of rules and the UI has one line to show.
		if (!/^[\w./-]+$/.test(name) || name.startsWith("-") || name.includes(".."))
			return fail(`invalid branch name: ${name}`);
		const checkout = await git(cwd, ["checkout", "-b", name]);
		if (checkout.code !== 0) return fail(checkout.stderr || `could not create branch ${name}`);
		steps.push({ step: `branch ${name}`, output: checkout.stderr || checkout.stdout });
	}

	if (plan.message !== undefined) {
		const message = plan.message.trim();
		if (!message) return fail("a commit needs a message");
		if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) return fail("commit message too long");

		// `-A` and not `-u`: untracked files are part of what an agent produced,
		// and a commit that silently omits the new file it just wrote is the
		// worst outcome available here.
		const add = await git(cwd, ["add", "-A"]);
		if (add.code !== 0) return fail(add.stderr || "could not stage changes");

		const commit = await git(cwd, ["commit", "-m", message]);
		if (commit.code !== 0) return fail(commit.stdout || commit.stderr || "commit failed");
		steps.push({ step: "commit", output: commit.stdout });
	}

	if (plan.push) {
		if (!state.remote && !plan.branch) return fail("this repository has no remote");
		const branch = plan.branch?.trim() || state.branch;
		// A branch with no upstream needs one, and doing it in the same click is
		// the difference between "Push" working and "Push" printing git's
		// suggestion for the command you should have run.
		const args =
			plan.branch || !state.upstream
				? ["push", "--set-upstream", state.remote || "origin", branch]
				: ["push"];
		const push = await git(cwd, args);
		if (push.code !== 0) return fail(push.stderr || "push failed");
		steps.push({ step: "push", output: push.stderr || push.stdout });
	}

	let url: string | undefined;
	if (plan.pr) {
		if (!state.gh) return fail("`gh` is not installed, so a PR cannot be opened from here");
		// `--fill` takes the title and body from the commits, which is the only
		// source of truth this host has for what the PR is.
		const pr = await run(cwd, "gh", ["pr", "create", "--fill"]);
		if (pr.code !== 0) return fail(pr.stderr || "could not create the PR");
		url = pr.stdout.split("\n").find((line) => line.startsWith("http"));
		steps.push({ step: "pull request", output: pr.stdout || pr.stderr });
	}

	return { ok: true, steps, url };
}
