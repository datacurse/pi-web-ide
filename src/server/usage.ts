/**
 * usage.ts — Claude subscription limits, straight from the endpoint claude.ai's
 * usage page reads, plus a history of them for Stats' pace charts.
 *
 * Borrows pi's OAuth access token from auth.json, newest first. An expired one
 * is refreshed through `pi auth print-bearer-token`, which rotates it under
 * pi's own auth.json lock — refreshing here directly could race pi and log it out.
 *
 * Anthropic rate-limits this endpoint hard (a second call within a minute gets
 * 429), and Stats asks on every open and reply. So a good answer is reused for
 * a minute, and served instead of an error when a later call fails.
 *
 * Every fresh answer, and a poll every ten minutes, appends a sample to
 * `usage-history.json`, so the chart has a curve even for hours Stats was shut.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PI_BIN } from "./agent.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";
import type { UsageSample } from "../shared/types.js";

interface Limit {
	kind?: string;
	percent?: number;
	resets_at?: string | null;
	scope?: { model?: { display_name?: string | null } } | null;
}

const TTL_MS = 60_000;
/** A week's window plus a day, so a whole weekly window always fits. */
const KEEP_MS = 8 * 86_400_000;
const POLL_MS = 10 * 60_000;
const historyPath = () => statePath("usage-history.json");

let cache: { at: number; body: Record<string, unknown> } | undefined;

export function readHistory(): UsageSample[] {
	try {
		const h = JSON.parse(readStateFile(historyPath()) ?? "[]");
		return Array.isArray(h) ? h : [];
	} catch {
		return [];
	}
}

function record(body: Record<string, unknown>, at: number): void {
	const limits = Array.isArray(body.limits) ? (body.limits as Limit[]) : [];
	const sample: UsageSample = {
		at,
		limits: limits
			.filter((l) => typeof l.percent === "number")
			.map((l) => ({
				kind: l.kind ?? "",
				model: l.scope?.model?.display_name ?? null,
				percent: l.percent!,
				resets_at: l.resets_at ?? null,
			})),
	};
	const kept = readHistory().filter((s) => at - s.at < KEEP_MS);
	writeStateFile(historyPath(), JSON.stringify([...kept, sample]));
}

/** Anthropic's usage answer, or an error message for Stats to show. */
export async function fetchUsage(): Promise<{ body: Record<string, unknown> } | { error: string }> {
	if (cache && Date.now() - cache.at < TTL_MS) return { body: cache.body };
	const dir = process.env.PI_CODING_AGENT_DIR ?? resolve(process.env.HOME ?? "", ".pi/agent");
	let auth: Record<string, { type?: string; access?: string; expires?: number }> = {};
	try {
		auth = JSON.parse(readFileSync(resolve(dir, "auth.json"), "utf8"));
	} catch {}
	const tokens = Object.entries(auth)
		.filter(([, c]) => c.type === "oauth" && c.access)
		.sort(([, a], [, b]) => (b.expires ?? 0) - (a.expires ?? 0));
	let status: number | undefined;
	for (const [provider, c] of tokens) {
		const access =
			(c.expires ?? 0) > Date.now()
				? c.access
				: await promisify(execFile)(PI_BIN, ["auth", "print-bearer-token", "--provider", provider], {
						timeout: 20_000,
					})
						.then((r) => r.stdout.trim())
						.catch(() => "");
		if (!access) continue;
		const get = (path: string) =>
			fetch(`https://api.anthropic.com/api/oauth/${path}`, {
				headers: { authorization: `Bearer ${access}`, "anthropic-beta": "oauth-2025-04-20" },
			}).catch(() => null);
		const [r, p] = await Promise.all([get("usage"), get("profile")]);
		if (r?.ok) {
			const org = p?.ok ? ((await p.json().catch(() => ({}))) as { organization?: Record<string, unknown> }).organization : undefined;
			const subscription = org && {
				plan: org.organization_type ?? null,
				status: org.subscription_status ?? null,
				since: org.subscription_created_at ?? null,
			};
			cache = { at: Date.now(), body: { ...((await r.json()) as Record<string, unknown>), subscription } };
			try {
				record(cache.body, cache.at);
			} catch (err) {
				console.error("usage history not saved:", err);
			}
			return { body: cache.body };
		}
		status = r?.status ?? 0;
	}
	if (cache) return { body: cache.body };
	return {
		error: !tokens.length
			? "no Claude login in auth.json"
			: status === undefined
				? "Claude login expired and pi could not refresh it"
				: status === 429
					? "Anthropic is rate-limiting the usage check; try again in a minute"
					: `usage request failed (${status ? `HTTP ${status}` : "network error"})`,
	};
}

/** Keep sampling while nobody looks, so the pace chart has no holes. */
export function pollUsage(): void {
	setInterval(() => void fetchUsage().catch(() => {}), POLL_MS).unref();
}
