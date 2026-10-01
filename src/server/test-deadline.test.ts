import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the suite's outer deadline stops a worker still alive after its assertions finish", () => {
	const script = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).scripts.test as string;
	assert.match(script, /^timeout --kill-after=5s 30s node /);
	assert.match(script, /--test-timeout=10000/);
	const dir = mkdtempSync(join(tmpdir(), "pwi-test-deadline-"));
	try {
		const file = join(dir, "stuck.test.mjs");
		writeFileSync(file, 'console.log("assertions finished"); setInterval(() => {}, 1000);\n');
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const result = spawnSync("timeout", ["--kill-after=1s", "1s", process.execPath, "--test", "--test-timeout=100", file], {
			encoding: "utf8", timeout: 4000, env,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 124);
		assert.match(result.stdout, /assertions finished/);
		assert.match(result.stdout + result.stderr, /stuck\.test\.mjs/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
