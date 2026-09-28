// Run: node --import tsx --test src/server/app.test.ts
//
// The HTTP API in-process, through `app.request()`: no port, no pi, no tmux.
// What is pinned here is the boundary every route shares — the origin and
// host checks, body parsing and limits, error shapes, no-store — plus the
// file routes' refusal to leave the project, because those are the parts a
// route rewrite could quietly lose.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import type { Registry } from "./registry.js";
import type { Terminals } from "./terminals.js";

// Projects are server state; a test must never read or write the real list.
process.env.PWI_STATE_DIR = mkdtempSync(join(tmpdir(), "pwi-app-test-"));
const project = mkdtempSync(join(tmpdir(), "pwi-app-project-"));
writeFileSync(join(project, "hello.txt"), "hi\n");
mkdirSync(join(project, "sub"));

// Only what the tested routes touch; anything else would throw, which is a
// test failure pointing at the route that reached further than expected.
const registry = {
	get: () => undefined,
	abort: async () => {
		throw new Error("pi is gone");
	},
} as unknown as Registry;

const app = createApp({
	cwd: project,
	model: undefined,
	registry,
	terminals: {} as Terminals,
	piVersion: "0.0.0",
	pwiVersion: "0.0.0",
	boot: "boot",
	degraded: () => false,
});

const HOST = { Host: "127.0.0.1:8890" };
const json = (body: string, headers: Record<string, string> = {}) => ({
	method: "POST",
	body,
	headers: { ...HOST, "Content-Type": "application/json", ...headers },
});

test("a request with no Origin (curl, the server itself) is served", async () => {
	const r = await app.request("/api/health", { headers: HOST });
	assert.equal(r.status, 200);
	assert.equal((await r.json()).ok, true);
});

test("a foreign Origin is refused on every /api path", async () => {
	for (const path of ["/api/health", "/api/projects", "/api/nope", "/api"]) {
		const r = await app.request(path, { headers: { ...HOST, Origin: "http://evil.example" } });
		assert.equal(r.status, 403, path);
		assert.deepEqual(await r.json(), { error: "forbidden" });
	}
});

test("a same-origin page is served, and so is one through tailscale serve", async () => {
	const own = await app.request("/api/health", { headers: { ...HOST, Origin: "http://127.0.0.1:8890" } });
	assert.equal(own.status, 200);
	const tailnet = await app.request("/api/health", {
		headers: { Host: "box.tail1234.ts.net", Origin: "https://box.tail1234.ts.net", "X-Forwarded-Host": "box.tail1234.ts.net" },
	});
	assert.equal(tailnet.status, 200);
});

test("a DNS-rebound Host is refused even when Origin matches it", async () => {
	const r = await app.request("/api/health", {
		headers: { Host: "evil.example:8890", Origin: "http://evil.example:8890" },
	});
	assert.equal(r.status, 403);
});

test("an unknown /api path is JSON 404, not the client's index.html", async () => {
	for (const method of ["GET", "POST"]) {
		const r = await app.request("/api/nope", { method, headers: HOST });
		assert.equal(r.status, 404);
		assert.deepEqual(await r.json(), { error: "no such endpoint" });
	}
});

test("every /api answer is no-store, errors included", async () => {
	for (const path of ["/api/health", "/api/nope", "/api/sessions/nope"]) {
		const r = await app.request(path, { headers: HOST });
		assert.equal(r.headers.get("cache-control"), "no-store", path);
	}
});

test("malformed JSON is a 400 with a message, not a crash", async () => {
	const r = await app.request("/api/projects", json("{nope"));
	assert.equal(r.status, 400);
	assert.deepEqual(await r.json(), { error: "invalid JSON body" });
});

test("a non-JSON body is not parsed, so a form POST carries nothing", async () => {
	const r = await app.request("/api/projects", json('{"path":"/tmp"}', { "Content-Type": "text/plain" }));
	assert.equal(r.status, 400);
	assert.deepEqual(await r.json(), { error: "path required" });
});

test("a body over 64 MB is refused before any route reads it", async () => {
	const r = await app.request("/api/upload?name=big", {
		method: "POST",
		body: new Uint8Array(64 * 1024 * 1024 + 1),
		headers: HOST,
	});
	assert.equal(r.status, 413);
});

test("a route that throws answers 500 with the message", async () => {
	const r = await app.request("/api/sessions/any/abort", { method: "POST", headers: HOST });
	assert.equal(r.status, 500);
	assert.deepEqual(await r.json(), { error: "pi is gone" });
});

test("a session the server does not have is 404, for the snapshot and the stream", async () => {
	assert.equal((await app.request("/api/sessions/nope", { headers: HOST })).status, 404);
	assert.equal((await app.request("/api/sessions/nope/events", { headers: HOST })).status, 404);
});

test("a prompt is validated before the session is looked up", async () => {
	const empty = await app.request("/api/sessions/nope/prompt", json("{}"));
	assert.equal(empty.status, 400);
	const badImage = await app.request("/api/sessions/nope/prompt", json('{"text":"hi","images":[{}]}'));
	assert.equal(badImage.status, 400);
	assert.match((await badImage.json()).error, /data, mimeType/);
});

test("files inside the project are served", async () => {
	const r = await app.request(`/api/file?path=${encodeURIComponent(join(project, "hello.txt"))}`, { headers: HOST });
	assert.equal(r.status, 200);
	assert.equal((await r.json()).content, "hi\n");
});

test("files outside every project are refused, however the path is spelled", async () => {
	for (const path of ["/etc/passwd", join(project, "..", "..", "etc", "passwd"), `${project}-secrets/x`]) {
		const r = await app.request(`/api/file?path=${encodeURIComponent(path)}`, { headers: HOST });
		assert.equal(r.status, 400, path);
		assert.match((await r.json()).error, /outside every known project/);
	}
	const download = await app.request("/api/download?path=/etc/passwd", { headers: HOST });
	assert.equal(download.status, 400);
});

test("a download is the file's bytes as an attachment, with a non-ASCII name intact", async () => {
	const name = "päckage (1).txt";
	writeFileSync(join(project, name), "bytes");
	const r = await app.request(`/api/download?path=${encodeURIComponent(join(project, name))}`, { headers: HOST });
	assert.equal(r.status, 200);
	assert.equal(await r.text(), "bytes");
	assert.equal(
		r.headers.get("content-disposition"),
		`attachment; filename="p?ckage (1).txt"; filename*=UTF-8''p%C3%A4ckage%20%281%29.txt`,
	);
});

test("file operations refuse to leave the project", async () => {
	const r = await app.request("/api/files/create", json('{"path":"/etc/pwi-test"}'));
	assert.equal(r.status, 400);
});
