import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RpcChild } from "./agent.js";

// A real detached process with the same fd-0 identity as pi. It deliberately
// ignores SIGTERM, keeping the shutdown/adoption race open deterministically.
test("closing children are not adopted; detached children still are", async () => {
	const root = mkdtempSync(join(tmpdir(), "pwi-handoff-"));
	const previous = process.env.PWI_STATE_DIR;
	process.env.PWI_STATE_DIR = root;
	try {
		for (const dispose of [false, true]) {
			const dir = join(root, dispose ? "closing" : "detached");
			execFileSync("mkdir", ["-p", dir]);
			const fifo = join(dir, "in");
			execFileSync("mkfifo", [fifo]);
			const fd = openSync(fifo, constants.O_RDWR);
			writeFileSync(join(dir, "out"), "");
			writeFileSync(join(dir, "err"), "");
			const proc = spawn(process.execPath, ["-e", `
				process.on("SIGTERM", () => {});
				process.stdout.write("ready");
				setInterval(() => {}, 1000);
			`], { detached: true, stdio: [fd, "pipe", "ignore"] });
			closeSync(fd);
			const exited = once(proc, "exit");
			let child: RpcChild | undefined;
			let adopted: RpcChild | undefined;
			try {
				await once(proc.stdout!, "data");
				assert.ok(proc.pid);
				writeFileSync(join(dir, "meta.json"), JSON.stringify({ pid: proc.pid, keep: true }));
				child = RpcChild.adopt(dir);
				assert.ok(child);
				if (dispose) child.close();
				else child.detach();
				assert.equal(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).keep, !dispose);
				process.kill(proc.pid, 0); // Still alive when the next server arrives.
				adopted = RpcChild.adopt(dir);
				assert.equal(Boolean(adopted), !dispose);
			} finally {
				adopted?.detach();
				child?.detach();
				if (proc.pid) process.kill(-proc.pid, "SIGKILL");
				await exited;
			}
		}
	} finally {
		if (previous === undefined) delete process.env.PWI_STATE_DIR;
		else process.env.PWI_STATE_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
