import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentInstructions, switchAgentInstructions } from "./agentInstructions.js";

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

test("switches independently, preserves outgoing versions, and refuses stale or unsafe writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pwi-instruction-versions-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const globalDir = join(root, "agent");
		const project = join(root, "project");
		const other = join(root, "other");
		await Promise.all([mkdir(globalDir), mkdir(project), mkdir(other)]);
		process.env.PI_CODING_AGENT_DIR = globalDir;
		const globalPath = join(globalDir, "AGENTS.md");
		const localPath = join(project, "AGENTS.md");
		await writeFile(globalPath, "global rules");
		await writeFile(localPath, "local rules");
		switchAgentInstructions(project, "global", null, "global rules");
		switchAgentInstructions(project, "local", null, "local rules");
		let result = await agentInstructions(project);
		assert.equal(result.global.content, "");
		assert.equal(result.local.content, "");
		assert.equal(result.backlog.global[0].content, "global rules");
		assert.equal(result.backlog.local[0].content, "local rules");
		const localVersion = result.backlog.local[0].id;
		switchAgentInstructions(project, "local", localVersion, "");
		result = await agentInstructions(project);
		assert.equal(result.local.content, "local rules");
		assert.equal(result.global.content, "");
		assert.equal(result.backlog.local.length, 2);
		assert.ok(result.backlog.local.some((v) => v.content === ""));
		assert.ok(result.backlog.local.some((v) => v.id === localVersion));
		assert.equal((await agentInstructions(other)).backlog.local.length, 0);
		assert.throws(() => switchAgentInstructions(other, "local", localVersion, null), /ENOENT/);
		assert.throws(() => switchAgentInstructions(project, "local", "../AGENTS.md", "local rules"), /invalid instruction version/);
		assert.throws(() => switchAgentInstructions(project, "local", null, ""), /changed on disk/);
		assert.equal(await readFile(localPath, "utf8"), "local rules");
		assert.equal((await agentInstructions(project)).backlog.local.length, 2);
		await rm(localPath);
		await symlink(globalPath, localPath);
		assert.throws(() => switchAgentInstructions(project, "local", null, ""), /regular file/);
		assert.equal(await readFile(globalPath, "utf8"), "");
		await rm(localPath);
		switchAgentInstructions(project, "local", null, null);
		assert.equal(await readFile(localPath, "utf8"), "");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
});
