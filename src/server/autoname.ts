/**
 * autoname.ts — one line describing the working tree, written by a model.
 *
 * The file list (`suggestMessage` in git.ts) is what the commit box is
 * prefilled with, because it is instant and cannot fail. It is also not a
 * commit message: "Update README.md, index.html and 53 more" says what was
 * touched and nothing about what was done. This is the other half — the
 * button that reads the diff and says it in a sentence.
 *
 * A SEPARATE omp process, not the session on screen: naming a commit must not
 * append a turn to the transcript the user is reading, must not inherit that
 * session's tools or its half-finished context, and must not be blocked
 * behind a run that is still going. `-p --no-session` is a stateless
 * question, spawned and gone.
 *
 * Everything optional is switched off. No tools, no LSP, no extensions, no
 * skills, no rules, no thinking, no session file, no title generation: the
 * job is one sentence about a diff that is already in the prompt, and each of
 * those is a discovery pass or a round trip that would make a commit message
 * take twenty seconds instead of four. Measured on this repo's own 20 kB
 * diff: 22.5 s with thinking, 4.6 s without.
 */

import { spawn } from "node:child_process";
import { changeSummary } from "./git.js";
import { smolModelSpec } from "./models.js";
import { OMP_BIN } from "./omp.js";

/** A cold model plus a slow link. Past this, the click has failed. */
const TIMEOUT_MS = 90_000;

/** A runaway child that answers in an essay stops being read at 64 kB. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Long enough for a real subject line, short enough to stay one. */
const MAX_SUBJECT_CHARS = 120;

/**
 * The rules are what stop a chat model from answering in prose. "Reply with
 * the message and nothing else" is the load-bearing one: without it the
 * answer arrives as "Here's a good commit message for your changes:" and a
 * blank line, and the first line of the reply is then not the message.
 */
const PROMPT = `Write a git commit message for the changes below.

Rules:
- One line, imperative mood, at most 72 characters.
- Say what the change does, not which files it touched.
- No quotes, no backticks, no trailing period, no "commit:" prefix.
- Reply with the message and nothing else.`;

/**
 * Name the commit that `Commit` would make in `cwd`.
 *
 * Throws rather than falling back to the file list: the caller (the dialog,
 * or the auto-name toggle) has the file list already and can decide whether
 * to use it, and a button labelled "Auto-name" that silently produced the
 * same text as the placeholder would look like it did nothing.
 */
export async function nameCommit(cwd: string): Promise<string> {
	const summary = await changeSummary(cwd);
	if (!summary) throw new Error("nothing to describe: the working tree is clean");

	const args = [
		"-p",
		"--no-session",
		"--no-tools",
		"--no-lsp",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-title",
		"--thinking=off",
		"--mode=text",
	];
	const model = await smolModelSpec().catch(() => undefined);
	if (model) args.push("--model", model);
	args.push(`${PROMPT}\n\n${summary}`);

	const stdout = await runOmp(cwd, args);

	// The first non-empty line, stripped of the quotes a model wraps a
	// requested string in about one time in five.
	const subject = (stdout.split("\n").find((line) => line.trim()) ?? "")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.slice(0, MAX_SUBJECT_CHARS)
		.trim();
	if (!subject) throw new Error("the model returned nothing");
	return subject;
}

/**
 * Spawn omp in print mode and collect stdout.
 *
 * `stdin: "ignore"` is not tidiness: omp reads piped stdin to EOF before it
 * starts, so a child given an open pipe it will never write to waits for the
 * timeout and answers nothing. Observed as a 120 s hang in "phase:
 * readPipedInput" the first time this was written with `execFile`.
 */
function runOmp(cwd: string, args: string[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn(OMP_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

	let stdout = "";
	let stderr = "";
	let settled = false;
	const finish = (err: Error | null, value = "") => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (err) reject(err);
		else resolve(value);
	};

	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish(new Error("naming this commit took too long"));
	}, TIMEOUT_MS);

	child.stdout.on("data", (chunk: Buffer) => {
		if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
	});
	// `spawn omp ENOENT` is the deployment mistake this reports most often;
	// see OMP_BIN in omp.ts for the PATH it is usually missing from.
	child.on("error", (err) => finish(err));
	child.on("close", (code) => {
		if (code === 0) return finish(null, stdout);
		// The last line of stderr is omp's own complaint (a missing key, an
		// unknown model); the rest is startup chatter nobody needs in a pill.
		const last = stderr.trim().split("\n").filter(Boolean).at(-1);
		finish(new Error(last || `omp exited with ${code}`));
	});

	return promise;
}
