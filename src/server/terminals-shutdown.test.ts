import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import type { Terminals } from "./terminals.js";

const source = ts.transpileModule(readFileSync(new URL("./terminals.ts", import.meta.url), "utf8"), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const require = createRequire(import.meta.url);

function harness(t: TestContext, mode: "graceful" | "force" | "manual", socket?: string) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const processes: FakePty[] = [];
	const tmuxCalls: string[][] = [];
	class FakePty {
		pid = 100 + processes.length;
		signals: string[] = [];
		exits = new Set<(event: { exitCode: number; signal: number }) => void>();
		onData() { return { dispose() {} }; }
		onExit(callback: (event: { exitCode: number; signal: number }) => void) {
			this.exits.add(callback);
			return { dispose: () => { this.exits.delete(callback); } };
		}
		write() {}
		resize() {}
		kill(signal: string) {
			this.signals.push(signal);
			if (mode === "graceful" || (mode === "force" && signal === "SIGKILL")) this.exit();
		}
		exit() { for (const callback of [...this.exits]) callback({ exitCode: 0, signal: 0 }); }
	}
	const exports = {} as { Terminals: typeof Terminals };
	runInNewContext(source, {
		exports, process, setTimeout, clearTimeout,
		require: (name: string) => {
			if (name === "@homebridge/node-pty-prebuilt-multiarch") return { spawn: () => {
				const pty = new FakePty(); processes.push(pty); return pty;
			} };
			if (name === "node:child_process") return { execFileSync: (_command: string, args: string[]) => {
				tmuxCalls.push(args); return "";
			} };
			switch (name) {
				case "node:fs": return require("node:fs");
				case "node:path": return require("node:path");
				case "node:crypto": return require("node:crypto");
				default: throw new Error(`Unexpected terminal dependency: ${name}`);
			}
		},
	});
	return { terminals: new exports.Terminals(socket), processes, tmuxCalls };
}

test("terminal close waits for the exit event, including through bulk disposal", async (t) => {
	const { terminals, processes } = harness(t, "manual");
	const term = terminals.create("/tmp", 80, 24);
	const closing = terminals.close(term.id);
	let disposed = false;
	const cleanup = terminals.disposeAll().then(() => { disposed = true; });
	await Promise.resolve();
	assert.equal(disposed, false);
	assert.deepEqual(processes[0].signals, ["SIGHUP"]);
	assert.equal(terminals.list("/tmp").length, 0);
	processes[0].exit();
	await Promise.all([closing, cleanup]);
	assert.equal(disposed, true);
	t.mock.timers.tick(3000);
	assert.deepEqual(processes[0].signals, ["SIGHUP"], "successful cleanup cancels escalation");
});

test("a PTY ignoring SIGHUP is escalated to SIGKILL after one second", async (t) => {
	const { terminals, processes } = harness(t, "force");
	const term = terminals.create("/tmp", 80, 24);
	const closing = terminals.close(term.id);
	t.mock.timers.tick(999);
	assert.deepEqual(processes[0].signals, ["SIGHUP"]);
	t.mock.timers.tick(1);
	await closing;
	assert.deepEqual(processes[0].signals, ["SIGHUP", "SIGKILL"]);
	t.mock.timers.tick(2000);
	await terminals.disposeAll();
});

test("missing PTY exit events fail with terminal and PID context instead of hanging", async (t) => {
	const { terminals, processes } = harness(t, "manual");
	const term = terminals.create("/tmp", 80, 24);
	const failure = assert.rejects(terminals.close(term.id), /Terminal .*PTY pid 100.*did not exit within 2000ms/);
	t.mock.timers.tick(2000);
	await failure;
	assert.deepEqual(processes[0].signals, ["SIGHUP", "SIGKILL"]);
	assert.equal(processes[0].exits.size, 1, "the temporary wait listener was disposed");
});

test("bulk tmux shutdown waits for clients without killing persistent sessions", async (t) => {
	const { terminals, processes, tmuxCalls } = harness(t, "manual", "isolated-test-socket");
	terminals.create("/tmp", 80, 24);
	const cleanup = terminals.disposeAll();
	assert.deepEqual(processes[0].signals, ["SIGHUP"]);
	assert.ok(tmuxCalls.every((args) => !args.includes("kill-session")));
	processes[0].exit();
	await cleanup;
});

test("already exited PTYs are not signalled again", async (t) => {
	const { terminals, processes } = harness(t, "graceful");
	const term = terminals.create("/tmp", 80, 24);
	processes[0].exit();
	await terminals.close(term.id);
	assert.deepEqual(processes[0].signals, []);
	await terminals.close("unknown");
});
