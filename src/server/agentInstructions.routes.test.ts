import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hc } from "hono/client";
import { createApp } from "./app.js";
import type { Registry } from "./registry.js";
import type { Terminals } from "./terminals.js";

test("instruction API validates writes and invalidates prewarmed sessions on successful switches", async () => {
	const root = await mkdtemp(join(tmpdir(), "pwi-instruction-api-"));
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	const previousState = process.env.PWI_STATE_DIR;
	try {
		const project = join(root, "project");
		await mkdir(project);
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		process.env.PWI_STATE_DIR = join(root, "state");
		await writeFile(join(project, "AGENTS.md"), "rules");
		let discarded = 0;
		const app = createApp({
			cwd: project, model: undefined, piVersion: undefined, pwiVersion: "test", boot: "test",
			degraded: () => false,
			registry: { discardSpares: () => { discarded++; } } as unknown as Registry,
			terminals: {} as Terminals,
		});
		const headers = { Host: "127.0.0.1:8890" };
		const api = hc<typeof app>("http://127.0.0.1:8890/", {
			headers,
			fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init),
		}).api;
		for (const body of [
			{},
			{ scope: "other", version: null, expected: "rules" },
			{ scope: "local", version: "../AGENTS.md", expected: "rules" },
			{ scope: "local", version: null, expected: "" },
			{ scope: "local", version: null },
		]) {
			const response = await app.request("/api/agent-instructions", {
				method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
			});
			assert.equal(response.status, 400);
		}
		const outside = await api["agent-instructions"].$post({
			query: { cwd: join(root, "outside") }, json: { scope: "local", version: null, expected: null },
		});
		assert.equal(outside.status, 400);
		assert.equal(discarded, 0);
		assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), "rules");
		const response = await api["agent-instructions"].$post({
			query: { cwd: project }, json: { scope: "local", version: null, expected: "rules" },
		});
		assert.equal(response.status, 200);
		if (response.status !== 200) throw new Error("switch failed");
		const data = await response.json();
		assert.equal(data.local.content, "");
		assert.equal(data.backlog.local[0].content, "rules");
		assert.equal(discarded, 1);
		const restored = await api["agent-instructions"].$post({
			query: { cwd: project }, json: { scope: "local", version: data.backlog.local[0].id, expected: "" },
		});
		assert.equal(restored.status, 200);
		assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), "rules");
		assert.equal(discarded, 2);
		for (const body of [
			{},
			{ scope: "local", content: 42, expected: "rules" },
			{ scope: "local", content: "edited" },
			{ scope: "other", content: "edited", expected: "rules" },
			{ scope: "local", content: "edited", expected: "" },
		]) {
			const response = await app.request("/api/agent-instructions", {
				method: "PUT", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
			});
			assert.equal(response.status, 400);
		}
		const outsideEdit = await api["agent-instructions"].$put({
			query: { cwd: join(root, "outside") }, json: { scope: "local", content: "edited", expected: null },
		});
		assert.equal(outsideEdit.status, 400);
		assert.equal(discarded, 2);
		const edited = await api["agent-instructions"].$put({
			query: { cwd: project }, json: { scope: "local", content: "# Edited\nNew rules.\n", expected: "rules" },
		});
		assert.equal(edited.status, 200);
		if (edited.status !== 200) throw new Error("save failed");
		const saved = await edited.json();
		assert.equal(saved.local.content, "# Edited\nNew rules.\n");
		assert.ok(saved.backlog.local.some((v) => v.content === "rules"));
		assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), "# Edited\nNew rules.\n");
		assert.equal(discarded, 3);
	} finally {
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
		if (previousState === undefined) delete process.env.PWI_STATE_DIR;
		else process.env.PWI_STATE_DIR = previousState;
		await rm(root, { recursive: true, force: true });
	}
});
