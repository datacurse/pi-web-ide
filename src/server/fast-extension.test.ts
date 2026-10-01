import assert from "node:assert/strict";
import { test } from "node:test";
import setup from "./fast-extension.js";
import { FAST_COMMAND, supportsFastMode } from "../shared/fastMode.js";

type Pi = Parameters<typeof setup>[0];
type Command = Parameters<Pi["registerCommand"]>[1]["handler"];
type Context = Parameters<Command>[1];
type Hook = (event: { payload?: unknown }, ctx: Context) => unknown;

function fixture(saved: boolean[] = []) {
	const entries = saved.map((enabled) => ({ type: "custom", customType: FAST_COMMAND, data: { enabled } }));
	const hooks = new Map<string, Hook>();
	let command: Command | undefined;
	let reply: { enabled: boolean; error?: string } | undefined;
	let idle = true;
	const ctx: Context = {
		model: { provider: "openai-codex", id: "gpt-6.1-sol" },
		isIdle: () => idle,
		sessionManager: { getEntries: () => entries },
		ui: { setStatus(key, text) { assert.equal(key, FAST_COMMAND); reply = JSON.parse(text); } },
	};
	setup({
		on(event, handler) { hooks.set(event, handler as Hook); },
		registerCommand(name, options) { assert.equal(name, FAST_COMMAND); command = options.handler; },
		appendEntry(type, data) { entries.push({ type: "custom", customType: type, data: data as { enabled: boolean } }); },
	});
	const restart = () => hooks.get("session_start")!({}, ctx);
	restart();
	return {
		ctx, entries, restart,
		setIdle(value: boolean) { idle = value; },
		command(args: string) { command!(args, ctx); return reply!; },
		payload(payload: unknown) { return hooks.get("before_provider_request")!({ payload }, ctx); },
	};
}

test("Fast is opt-in and updates the actual provider payload independently of reasoning", () => {
	const f = fixture();
	const payload = { model: "gpt-6.1-sol", reasoning: { effort: "high" }, input: [] };
	assert.deepEqual(f.payload(payload), { ...payload, service_tier: "default" });
	assert.equal(f.command("status").enabled, false);
	assert.deepEqual(f.entries.map((entry) => entry.data.enabled), [false]);
	assert.equal(f.command("on").enabled, true);
	assert.deepEqual(f.payload(payload), { ...payload, service_tier: "priority" });
	assert.equal("service_tier" in payload, false, "does not mutate another extension's payload");
	assert.deepEqual(f.entries.map((entry) => entry.data.enabled), [false, true, true]);
	f.command("on");
	assert.equal(f.entries.length, 3, "idempotent saves do not add entries");
	f.command("off");
	assert.deepEqual(f.payload({ ...payload, service_tier: "priority" }), { ...payload, service_tier: "default" });
	assert.deepEqual(f.entries.map((entry) => entry.data.enabled), [false, true, true, false, false]);
});

test("session restart restores the last persisted preference", () => {
	const f = fixture([true, false, true]);
	assert.equal(f.command("status").enabled, true);
	f.command("off");
	f.restart();
	assert.equal(f.command("status").enabled, false);
	assert.equal(f.entries.at(-1)?.customType, FAST_COMMAND);
});

test("unsupported models and nested requests never receive Sol's priority tier", () => {
	const f = fixture([true]);
	assert.equal(f.payload({ model: "another-model" }), undefined);
	f.ctx.model = { provider: "anthropic", id: "claude-opus-5-5" };
	assert.match(f.command("on").error!, /not supported/);
	assert.equal(f.payload({ model: "gpt-6.1-sol" }), undefined);
	assert.equal(f.entries.length, 1);
	assert.equal(supportsFastMode("openai/gpt-6.1-sol"), false);
	assert.equal(supportsFastMode(undefined), false);
});

test("streaming and malformed commands cannot change the setting", () => {
	const f = fixture();
	f.setIdle(false);
	assert.match(f.command("on").error!, /streaming/);
	assert.equal(f.command("status").enabled, false);
	f.setIdle(true);
	assert.match(f.command("unexpected").error!, /expected/);
	assert.equal(f.entries.length, 0);
	assert.equal(f.payload(null), undefined);
	assert.equal(f.payload("invalid"), undefined);
});
