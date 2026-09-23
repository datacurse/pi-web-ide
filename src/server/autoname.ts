/**
 * autoname.ts — one line describing the working tree, written by a model.
 *
 * The file list (`suggestMessage` in git.ts) is what the commit box is
 * prefilled with, because it is instant and cannot fail. It is also not a
 * commit message: "Update README.md, index.html and 53 more" says what was
 * touched and nothing about what was done. This is the other half — the
 * button that reads the diff and says it in a sentence.
 *
 * A SEPARATE pi process, not the session on screen: naming a commit must not
 * append a turn to the transcript the user is reading, must not inherit that
 * session's tools or its half-finished context, and must not be blocked
 * behind a run that is still going. `-p --no-session` is a stateless
 * question, spawned and gone.
 *
 * Everything optional is switched off. No tools, no extensions, no skills, no
 * prompt templates, no context files, no thinking, no session file: the job
 * is one sentence about a diff that is already in the prompt, and each of
 * those is a discovery pass or a round trip that would make a commit message
 * take twenty seconds instead of four. Measured on this repo's own 20 kB
 * diff: 22.5 s with thinking, 4.9 s without.
 */

import { spawn } from "node:child_process";
import { changeSummary } from "./git.js";
import { PI_BIN } from "./agent.js";

/**
 * Which model writes the line. Unset means pi's configured default; set it to
 * a cheap one, because this runs on a button press and the answer is one
 * sentence.
 */
const NAMING_MODEL = process.env.PWI_NAMING_MODEL;

/** A cold model plus a slow link. Past this, the click has failed. */
const TIMEOUT_MS = 90_000;

/** A runaway child that answers in an essay stops being read at 64 kB. */
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Long enough for a real subject line, short enough to stay one. */
const MAX_SUBJECT_CHARS = 120;

/** A body is context, not a changelog. Past this the box stops being readable. */
const MAX_BODY_CHARS = 2_000;

/** A session name is a tab label, not a sentence. */
const MAX_NAME_CHARS = 60;

/** Enough of the opening request to know what the session is about. */
const SESSION_INPUT_MAX = 2_000;

/**
 * Everything a one-shot naming child does not need. Skills, prompt templates
 * and context files are pure latency here, and thinking measured 22.5 s
 * against 4.9 s on this repo's own 20 kB diff.
 *
 * `--no-extensions` is NOT here, and that is load-bearing: a pi PROVIDER can
 * come from an installed package — `npm:pi-sub-anthropic` is exactly that —
 * so a child started without extension discovery cannot authenticate the
 * default model at all. Measured: with `--no-extensions` every naming call
 * failed with the provider's own 400 ("Third-party apps now draw from your
 * extra usage"), because pi had fallen back to a credential the package
 * normally supersedes; without it, the same prompt answers in 3.2 s.
 *
 * Unset PWI_NAMING_MODEL means pi's own default model, which is never wrong
 * — just slower and dearer than a small one for a one-sentence chore.
 */
const ONESHOT = [
	"-p",
	"--no-session",
	"--no-tools",
	"--no-skills",
	"--no-prompt-templates",
	"--no-context-files",
	"--thinking",
	"off",
];

/**
 * The rules are what stop a chat model from answering in prose. "Reply with
 * the message and nothing else" is the load-bearing one: without it the
 * answer arrives as "Here's a good commit message for your changes:" and a
 * blank line, and the first line of the reply is then not the message.
 */
const COMMIT_PROMPT = `Write a git commit message for the changes below.

Rules:
- First line: imperative mood, at most 72 characters, no trailing period.
- Then a blank line, then a body of 1-4 short paragraphs or "-" bullets.
- The subject says WHAT changed; the body says WHY, and what it fixes or
  replaces. Skip the body only when the diff is a trivial one-liner.
- Say what the change does, not which files it touched.
- No quotes, no backticks, no "commit:" prefix, no markdown headings.
- Reply with the message and nothing else.`;

const SESSION_PROMPT = `Write a short title for a coding session that opens with the request below.

Rules:
- Three to six words, no trailing period.
- Name the work, not the person asking for it.
- No quotes, no backticks, no "title:" prefix.
- Reply with the title and nothing else.`;

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

	const args = [...ONESHOT, ...(NAMING_MODEL ? ["--model", NAMING_MODEL] : [])];
	args.push(`${COMMIT_PROMPT}\n\n${summary}`);

	const message = subjectAndBody(await runPi(cwd, args));
	if (!message) throw new Error("the model returned nothing");
	return message;
}

/**
 * A git message out of the model's reply: subject, blank line, body.
 *
 * The subject goes through the same squeeze as a session name (one line,
 * unquoted, capped) because that is the part git and every log viewer treat
 * as special. The body is kept verbatim apart from a length cap — rewrapping
 * it here would mangle the bullets the prompt asks for, and the dialog's
 * textarea is where a human edits it anyway.
 */
export function subjectAndBody(stdout: string): string {
	const lines = stdout.split("\n");
	const start = lines.findIndex((line) => line.trim());
	if (start < 0) return "";

	const subject = firstLine(lines[start] ?? "", MAX_SUBJECT_CHARS);
	const body = lines
		.slice(start + 1)
		.join("\n")
		.trim()
		.slice(0, MAX_BODY_CHARS)
		.trim();
	if (!subject) return "";
	return body ? `${subject}\n\n${body}` : subject;
}

/**
 * Name a session from its opening request.
 *
 * pi has no `/rename` command and no titler of its own, so the title is
 * generated here the same way a commit message is — one stateless print-mode
 * child, no tools, no session. The opening request is the whole input: it is
 * what the session is ABOUT, and feeding a whole transcript to name it would
 * cost more than the session's next turn.
 */
export async function nameSession(cwd: string, opening: string): Promise<string> {
	const text = opening.trim();
	if (!text) throw new Error("nothing to name: this session has no messages yet");

	const args = [...ONESHOT, ...(NAMING_MODEL ? ["--model", NAMING_MODEL] : [])];
	args.push(`${SESSION_PROMPT}\n\n${text.slice(0, SESSION_INPUT_MAX)}`);

	const name = firstLine(await runPi(cwd, args), MAX_NAME_CHARS);
	if (!name) throw new Error("the model returned nothing");
	return name;
}

/**
 * The first non-empty line, stripped of the quotes a model wraps a requested
 * string in about one time in five.
 */
function firstLine(stdout: string, max: number): string {
	return (stdout.split("\n").find((line) => line.trim()) ?? "")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\s+/g, " ")
		.slice(0, max)
		.trim();
}

/**
 * Spawn pi in print mode and collect stdout.
 *
 * `stdin: "ignore"` is not tidiness: print mode merges piped stdin into the
 * prompt and reads it to EOF before starting, so a child given an open pipe
 * it will never write to waits for the timeout and answers nothing.
 */
function runPi(cwd: string, args: string[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn(PI_BIN, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

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
	// `spawn pi ENOENT` is the deployment mistake this reports most often;
	// see PI_BIN in agent.ts for the PATH it is usually missing from.
	child.on("error", (err) => finish(err));
	child.on("close", (code) => {
		if (code === 0) return finish(null, stdout);
		// The last line of stderr is pi's own complaint (a missing key, an
		// unknown model); the rest is startup chatter nobody needs in a pill.
		const last = stderr.trim().split("\n").filter(Boolean).at(-1);
		finish(new Error(last || `pi exited with ${code}`));
	});

	return promise;
}
