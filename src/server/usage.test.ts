import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultUsageProvider, fetchUsage, parseAnthropicUsage, parseOpenAIUsage, readHistory } from "./usage.js";

const dir = mkdtempSync(join(tmpdir(), "pwi-provider-usage-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PWI_STATE_DIR = dir;
process.env.PWI_PI_SETTINGS = join(dir, "settings.json");
writeFileSync(process.env.PWI_PI_SETTINGS, JSON.stringify({ defaultProvider: "openai-codex" }));
let now = Date.now();
const realNow = Date.now;
const realFetch = globalThis.fetch;
Date.now = () => now;
writeFileSync(join(dir, "auth.json"), JSON.stringify({
	"openai-codex": { type: "oauth", access: "openai-token", accountId: "account", expires: now + 1_000_000 },
	anthropic: { type: "oauth", access: "anthropic-token", expires: now + 1_000_000 },
	"pi-sub-anthropic": { type: "oauth", access: "sub-token", expires: now + 1_000_000 },
	other: { type: "oauth", access: "other-token", expires: now + 1_000_000 },
}));
const openai = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 2_000_000_000 },
		secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 2_000_600_000 },
	},
};
const requests: { url: string; token: string }[] = [];
let failOpenAI = false;
globalThis.fetch = async (url, init) => {
	const headers = new Headers(init?.headers);
	requests.push({ url: String(url), token: headers.get("authorization") ?? "" });
	if (String(url).includes("chatgpt.com")) {
		assert.equal(headers.get("authorization"), "Bearer openai-token");
		assert.equal(headers.get("chatgpt-account-id"), "account");
		assert.equal(headers.has("anthropic-beta"), false);
		return failOpenAI ? new Response("", { status: 429 }) : Response.json(openai);
	}
	assert.ok(["Bearer anthropic-token", "Bearer sub-token"].includes(headers.get("authorization") ?? ""));
	assert.equal(headers.has("chatgpt-account-id"), false);
	return Response.json(String(url).endsWith("profile")
		? { organization: { organization_type: "claude_max", subscription_status: "active", subscription_created_at: "2026-01-01" } }
		: { limits: [{ kind: "session", group: "session", percent: 10, resets_at: "2026-10-09", scope: null }] });
};
try {
	assert.equal(defaultUsageProvider(), "openai-codex");
	const [first, same] = await Promise.all([fetchUsage(), fetchUsage()]);
	assert.deepEqual(first, same);
	assert.equal(requests.length, 1);
	assert.ok("body" in first);
	assert.equal(first.body.limits[0]?.windowMs, 18_000_000);
	assert.equal(first.body.limits[1]?.percent, 40);
	await fetchUsage();
	assert.equal(requests.length, 1);
	await fetchUsage("anthropic");
	await fetchUsage("pi-sub-anthropic");
	assert.equal(requests.length, 5);
	assert.equal(readHistory("openai-codex").length, 1);
	assert.equal(readHistory("anthropic").length, 1);
	assert.equal(readHistory("pi-sub-anthropic").length, 1);
	const unsupported = await fetchUsage("other");
	assert.ok("body" in unsupported && unsupported.body.message);
	await fetchUsage("not-logged-in");
	assert.equal(requests.length, 5);
	now += 61_000;
	failOpenAI = true;
	const stale = await fetchUsage("openai-codex");
	assert.ok("body" in stale && stale.body.stale);
	assert.equal(stale.body.provider, "openai-codex");
	await fetchUsage("openai-codex");
	assert.equal(requests.length, 6);
	assert.ok(requests.every((r) => !r.token.includes("other-token")));
	assert.ok(!readFileSync(join(dir, "usage-history.json"), "utf8").includes("token"));
	assert.deepEqual(readHistory("other"), []);
	writeFileSync(join(dir, "usage-history.json"), JSON.stringify([{ at: now, limits: [] }]));
	assert.equal(readHistory("anthropic").length, 1);
	assert.equal(readHistory("openai-codex").length, 0);
	const weekly = parseOpenAIUsage({ plan_type: "prolite", rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 1000 } } }, "openai-codex", now);
	assert.equal(weekly.limits[0]?.group, "weekly");
	assert.equal(weekly.limits[0]?.windowMs, 604_800_000);
	assert.equal(weekly.limits[0]?.resets_at, new Date(now + 1_000_000).toISOString());
	assert.throws(() => parseOpenAIUsage({}), /no usage limits/);
	assert.throws(() => parseOpenAIUsage({ rate_limit: {} }), /no usage windows/);
	assert.throws(() => parseAnthropicUsage({}, "anthropic"), /no usage limits/);
} finally {
	globalThis.fetch = realFetch;
	Date.now = realNow;
	rmSync(dir, { recursive: true, force: true });
}
