import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentInstructions } from "./agentInstructions.js";

test("reads global and project instructions independently, including missing and unreadable files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pwi-instructions-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const globalDir = join(root, "agent");
		const project = join(root, "project");
		await Promise.all([mkdir(globalDir), mkdir(project)]);
		process.env.PI_CODING_AGENT_DIR = globalDir;
		const globalPath = join(globalDir, "AGENTS.md");
		const localPath = join(project, "AGENTS.md");
		await writeFile(globalPath, "# Global\nUse pnpm.\n");
		await writeFile(localPath, "# Project\nLocal rules.\n");
		let result = await agentInstructions(project);
		assert.deepEqual(result.global, { path: globalPath, content: "# Global\nUse pnpm.\n", error: null });
		assert.deepEqual(result.local, { path: localPath, content: "# Project\nLocal rules.\n", error: null });
		await rm(localPath);
		result = await agentInstructions(project);
		assert.equal(result.local.content, null);
		assert.equal(result.local.error, null);
		assert.equal(result.global.content, "# Global\nUse pnpm.\n");
		await writeFile(localPath, "");
		assert.equal((await agentInstructions(project)).local.content, "");
		await rm(localPath);
		await mkdir(localPath);
		result = await agentInstructions(project);
		assert.equal(result.local.content, null);
		assert.ok(result.local.error);
		assert.equal(result.global.error, null);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
