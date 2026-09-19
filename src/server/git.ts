/**
 * git.ts — the four git actions worth having in a chat window.
 *
 * An agent session ends with a working tree full of changes, and the next
 * thing anybody does is commit them. From a browser on another machine there
 * is no terminal to do it in — and now there is one (terminals.ts), but
 * typing `git add -A && git commit -m …` by hand on a phone is not the point.
 *
 * Deliberately NOT a git client. No staging UI, no hunks, no log, no diff
 * viewer: those are a real application, and piw already has a terminal for
 * the cases this does not cover. What is here is the end of an agent turn —
 * branch, commit, push, PR — composed from four independent steps, because
 * every combination anybody actually asks for (`Commit`, `Commit & Push`,
 * `Create Branch, Commit & Push`, `Commit & Create PR`) is a subset of those
 * four in that order.
 *
 * Every invocation is `execFile` with an argv array and no shell: a commit
 * message is arbitrary user text, and a shell would make `"; rm -rf ~"` a
 * commit message that means something else.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";

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

function run(
	cwd: string,
	file: string,
	args: string[],
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
			resolve({ code, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
		},
	);
	return promise;
}

const git = (cwd: string, args: string[]) => run(cwd, "git", args);

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
