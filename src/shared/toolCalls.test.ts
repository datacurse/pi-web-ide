import assert from "node:assert/strict";
import { test } from "node:test";
import { program, subKey } from "./toolCalls.js";

test("bash calls are named by the program that does the work", () => {
	assert.equal(program("grep -n foo src/x.ts"), "grep");
	assert.equal(program("cd /home/x && sed -n 1,20p a.ts"), "sed");
	assert.equal(program("cd ~/p && FOO=1 timeout 30 git -C sub log --oneline | head"), "git log");
	assert.equal(program("pnpm typecheck 2>&1 | tail -20"), "pnpm typecheck");
	assert.equal(program("pnpm exec tsc --noEmit"), "pnpm exec tsc");
	assert.equal(program("sudo systemctl --user restart pwi"), "systemctl restart");
	assert.equal(program("/usr/bin/python3 - <<'EOF'\nprint(1)\nEOF"), "python3");
	assert.equal(program("(cd x; ls -la)"), "ls");
	assert.equal(program("D=/opt/x; grep -rn foo $D"), "grep");
	assert.equal(program('echo "--- a"; for f in a b; do wc -l $f; done'), "wc");
	assert.equal(program("f=$(ls -t | head -1); jq . $f"), "jq");
	assert.equal(program("sleep 30 && curl -s localhost"), "sleep");
	assert.equal(program("cd x"), "cd");
	assert.equal(program(""), "?");
});

test("file tools split by path, other tools not at all", () => {
	assert.equal(subKey("read", { path: "src/a.ts" }), "src/a.ts");
	assert.equal(subKey("bash", { command: "git status" }), "git status");
	assert.equal(subKey("ffgrep", { pattern: "x" }), undefined);
});
