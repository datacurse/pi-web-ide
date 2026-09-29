import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MarkerStrip } from "./markers.ts";
import { buildSteps, parseTrace } from "./steps.ts";

const TRACE = fileURLToPath(new URL("./trace.bash", import.meta.url));

/** `command` through bash with trace.bash, as bash.ts runs it; output fed to the stripper in `split`-byte chunks. */
function run(command: string, split = 7) {
	const dir = mkdtempSync(join(tmpdir(), "tm-steps-"));
	const file = join(dir, "t.tsv");
	writeFileSync(file, "");
	let raw: Buffer;
	try {
		raw = execFileSync("bash", ["-c", command], {
			env: { ...process.env, BASH_ENV: TRACE, PWI_TM_TRACE: file, PWI_TM_MARK: "nonce1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		raw = (err as { stdout: Buffer }).stdout;
	}
	const strip = new MarkerStrip("nonce1");
	const parts: Buffer[] = [];
	for (let i = 0; i < raw.length; i += split) parts.push(strip.push(raw.subarray(i, i + split)));
	parts.push(strip.flush());
	const out = Buffer.concat(parts).toString();
	const { steps, background } = buildSteps({
		command,
		trace: parseTrace(readFileSync(file, "utf8")),
		marks: strip.at,
		total: strip.bytes,
		shownFrom: 0,
		ended: Date.now(),
	});
	return { out, steps, background };
}

test("markers never reach the output, whatever the chunking", () => {
	for (const split of [1, 3, 7, 1000]) {
		const { out } = run("echo one; printf two; echo three", split);
		assert.equal(out, "one\ntwothree\n");
	}
});

test("a chain splits into its commands as written, with output and exit status each", () => {
	const { steps } = run('cd /tmp && echo  "a  b"; printf "xyz" | cat 2>/dev/null; false; seq 3');
	assert.deepEqual(
		steps.map(({ text, exit, bytes }) => ({ text, exit, bytes })),
		[
			{ text: "cd /tmp", exit: 0, bytes: 0 },
			{ text: 'echo  "a  b"', exit: 0, bytes: 5 },
			{ text: 'printf "xyz" | cat 2>/dev/null', exit: 0, bytes: 3 },
			{ text: "false", exit: 1, bytes: 0 },
			{ text: "seq 3", exit: 0, bytes: 6 },
		],
	);
});

test("a loop body is one step run many times; a background job belongs to its step", () => {
	const { steps, background } = run("for i in 1 2 3; do echo $i; done; sleep 0.05 & echo x");
	const body = steps.find((s) => s.text === "echo $i");
	assert.equal(body?.runs, 3);
	assert.equal(body?.bytes, 6);
	assert.equal(background.length, 1);
	assert.equal(steps[background[0]!.step!]?.text, "sleep 0.05");
});

test("a job started last, or from a subshell, is still caught", () => {
	const last = run("echo x; sleep 0.05 &");
	assert.equal(last.steps[last.background[0]!.step!]?.text, "sleep 0.05");
	const sub = run("(sleep 0.05) & echo x");
	assert.equal(sub.background.length, 1);
	assert.equal(sub.background[0]!.step, undefined);
});

test("time goes to the command that took it", () => {
	const { steps } = run("echo fast; sleep 0.3; echo done");
	const sleep = steps.find((s) => s.text === "sleep 0.3");
	assert.ok(sleep && sleep.ms >= 250, `sleep took ${sleep?.ms}`);
	assert.ok(steps.every((s) => s === sleep || s.ms < 100));
});

test("only the tail the model saw counts as shown", () => {
	const strip = new MarkerStrip("n");
	strip.push(Buffer.from("\x1ePWIn:1\x1faaaa\x1ePWIn:2\x1fbbbbbb"));
	const trace = parseTrace("S\t1\t1.000\t0\techo a\nS\t2\t1.001\t0\techo b\nE\t2\t1.002\t0\n");
	const { steps } = buildSteps({
		command: "echo a; echo b",
		trace,
		marks: strip.at,
		total: strip.bytes,
		shownFrom: 7,
		ended: 0,
	});
	assert.deepEqual(
		steps.map((s) => [s.bytes, s.shown]),
		[
			[4, 0],
			[6, 3],
		],
	);
});
