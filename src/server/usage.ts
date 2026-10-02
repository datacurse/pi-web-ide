import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PI_BIN } from "./agent.js";
import { readSettings } from "./models.js";
import { isRecord } from "./guards.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";
import type { UsageSample } from "../shared/types.js";
import type { ProviderUsage, UsageLimit } from "../shared/usage.js";

const TTL_MS = 60_000;
const KEEP_MS = 8 * 86_400_000;
const POLL_MS = 10 * 60_000;
type Result = { body: ProviderUsage } | { error: string };
const cache = new Map<
  string,
  { at: number; result: Result; good?: ProviderUsage }
>();
const inFlight = new Map<string, Promise<Result>>();

function auth(): Record<string, unknown> {
  const dir =
    process.env.PI_CODING_AGENT_DIR ??
    resolve(process.env.HOME ?? "", ".pi/agent");
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(dir, "auth.json"), "utf8"),
    );
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function usageProviders(): string[] {
  const { defaultProvider } = readSettings();
  return [
    ...new Set([
      ...Object.keys(auth()),
      ...(typeof defaultProvider === "string" ? [defaultProvider] : []),
    ]),
  ].sort();
}

export function defaultUsageProvider(): string {
  const p = readSettings().defaultProvider;
  if (typeof p === "string" && p) return p;
  return (
    usageProviders().find(
      (p) =>
        p === "openai-codex" || p === "anthropic" || p === "pi-sub-anthropic",
    ) ?? ""
  );
}

export function readHistory(provider = defaultUsageProvider()): UsageSample[] {
  try {
    const h: unknown = JSON.parse(
      readStateFile(statePath("usage-history.json")) ?? "[]",
    );
    return Array.isArray(h)
      ? h.filter(
          (s): s is UsageSample =>
            isRecord(s) &&
            typeof s.at === "number" &&
            Array.isArray(s.limits) &&
            (s.provider === provider ||
              (s.provider === undefined &&
                (provider === "anthropic" || provider === "pi-sub-anthropic"))),
        )
      : [];
  } catch {
    return [];
  }
}

function record(body: ProviderUsage, at: number): void {
  let samples: UsageSample[] = [];
  try {
    const parsed: unknown = JSON.parse(
      readStateFile(statePath("usage-history.json")) ?? "[]",
    );
    if (Array.isArray(parsed))
      samples = parsed.filter(
        (s) =>
          isRecord(s) && typeof s.at === "number" && Array.isArray(s.limits),
      );
  } catch {
    throw new Error("usage-history.json is not valid JSON");
  }
  const previous = samples.findLast((s) => s.provider === body.provider);
  const sample: UsageSample = {
    provider: body.provider,
    at,
    limits: body.limits.map((l) => {
      const model = l.scope?.model?.display_name ?? null;
      const old = previous?.limits.find(
        (x) => x.kind === l.kind && x.model === model,
      );
      const planned = old?.resets_at ? Date.parse(old.resets_at) : NaN;
      const end = l.resets_at ? Date.parse(l.resets_at) : NaN;
      // Ignore deadline jitter and sub-percent corrections. A drop before the
      // previous deadline is an observed reset, even if that deadline stays put.
      const earlyReset =
        body.provider === "openai-codex" &&
        old &&
        Number.isFinite(end) &&
        planned > at + 60_000 &&
        l.percent <= old.percent - 1
          ? { plannedAt: old.resets_at!, previousPercent: old.percent }
          : undefined;
      if (earlyReset) {
        l.startedAt = at;
        console.info(
          `OpenAI usage early reset detected (${l.kind}) at ${new Date(at).toISOString()}; planned for ${earlyReset.plannedAt}; usage ${old!.percent}% → ${l.percent}%`,
        );
      } else if (old?.startedAt && Math.abs(end - planned) < 600_000) {
        l.startedAt = old.startedAt;
      }
      return {
        kind: l.kind,
        model,
        percent: l.percent,
        resets_at: l.resets_at,
        startedAt: l.startedAt,
        earlyReset,
      };
    }),
  };
  writeStateFile(
    statePath("usage-history.json"),
    JSON.stringify([...samples.filter((s) => at - s.at < KEEP_MS), sample]),
  );
}

export function parseOpenAIUsage(
  raw: unknown,
  provider = "openai-codex",
  now = Date.now(),
): ProviderUsage {
  if (!isRecord(raw) || !isRecord(raw.rate_limit))
    throw new Error("OpenAI returned no usage limits");
  const limits: UsageLimit[] = [];
  for (const [key, fallback] of [
    ["primary_window", "session"],
    ["secondary_window", "weekly"],
  ] as const) {
    const w = raw.rate_limit[key];
    if (
      !isRecord(w) ||
      typeof w.used_percent !== "number" ||
      !Number.isFinite(w.used_percent)
    )
      continue;
    const windowMs =
      typeof w.limit_window_seconds === "number" &&
      Number.isFinite(w.limit_window_seconds) &&
      w.limit_window_seconds > 0
        ? w.limit_window_seconds * 1000
        : undefined;
    const reset =
      typeof w.reset_at === "number"
        ? w.reset_at * 1000
        : typeof w.reset_after_seconds === "number"
          ? now + w.reset_after_seconds * 1000
          : NaN;
    limits.push({
      kind: `openai_${key}`,
      group: windowMs
        ? windowMs >= 2 * 86_400_000
          ? "weekly"
          : "session"
        : fallback,
      percent: Math.max(0, Math.min(100, w.used_percent)),
      resets_at:
        Number.isFinite(reset) && !Number.isNaN(new Date(reset).getTime())
          ? new Date(reset).toISOString()
          : null,
      windowMs,
      scope: null,
    });
  }
  if (!limits.length) throw new Error("OpenAI returned no usage windows");
  return {
    provider,
    limits,
    subscription:
      typeof raw.plan_type === "string"
        ? { plan: `ChatGPT ${raw.plan_type}`, status: null, since: null }
        : null,
  };
}

export function parseAnthropicUsage(
  raw: unknown,
  provider: string,
): ProviderUsage {
  if (!isRecord(raw) || !Array.isArray(raw.limits))
    throw new Error("Anthropic returned no usage limits");
  const limits: UsageLimit[] = raw.limits.flatMap((l) => {
    if (
      !isRecord(l) ||
      typeof l.kind !== "string" ||
      typeof l.percent !== "number" ||
      !Number.isFinite(l.percent)
    )
      return [];
    const model =
      isRecord(l.scope) &&
      isRecord(l.scope.model) &&
      typeof l.scope.model.display_name === "string"
        ? l.scope.model.display_name
        : null;
    return [
      {
        kind: l.kind,
        group: typeof l.group === "string" ? l.group : undefined,
        percent: l.percent,
        resets_at: typeof l.resets_at === "string" ? l.resets_at : null,
        scope: model ? { model: { display_name: model } } : null,
      },
    ];
  });
  return { provider, limits, subscription: null };
}

function accountId(token: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    );
    const claims = isRecord(payload)
      ? payload["https://api.openai.com/auth"]
      : undefined;
    return isRecord(claims) && typeof claims.chatgpt_account_id === "string"
      ? claims.chatgpt_account_id
      : undefined;
  } catch {
    return undefined;
  }
}

async function requestUsage(provider: string): Promise<Result> {
  const anthropic = provider === "anthropic" || provider === "pi-sub-anthropic";
  if (!anthropic && provider !== "openai-codex") {
    return {
      body: {
        provider,
        limits: [],
        subscription: null,
        message:
          "Subscription limits are not available for this provider. Session statistics are still shown.",
      },
    };
  }
  const credentials = auth()[provider];
  if (
    !isRecord(credentials) ||
    credentials.type !== "oauth" ||
    typeof credentials.access !== "string"
  ) {
    return {
      body: {
        provider,
        limits: [],
        subscription: null,
        message:
          "No subscription login for this provider. Session statistics are still shown.",
      },
    };
  }
  let access = credentials.access;
  if (
    typeof credentials.expires !== "number" ||
    credentials.expires <= Date.now()
  ) {
    access = await promisify(execFile)(
      PI_BIN,
      ["auth", "print-bearer-token", "--provider", provider],
      { timeout: 20_000 },
    )
      .then((r) => r.stdout.trim())
      .catch(() => "");
  }
  if (!access) return { error: "Login expired and pi could not refresh it" };
  const headers: Record<string, string> = { authorization: `Bearer ${access}` };
  if (anthropic) headers["anthropic-beta"] = "oauth-2025-04-20";
  else {
    const id =
      accountId(access) ??
      (typeof credentials.accountId === "string"
        ? credentials.accountId
        : undefined);
    if (id) headers["chatgpt-account-id"] = id;
  }
  const get = (url: string) =>
    fetch(url, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  try {
    const r = await get(
      anthropic
        ? "https://api.anthropic.com/api/oauth/usage"
        : "https://chatgpt.com/backend-api/wham/usage",
    );
    if (!r.ok)
      return {
        error:
          r.status === 429
            ? "Provider is rate-limiting the usage check; try again in a minute"
            : `Usage request failed (HTTP ${r.status})`,
      };
    const raw: unknown = await r.json();
    const body = anthropic
      ? parseAnthropicUsage(raw, provider)
      : parseOpenAIUsage(raw, provider);
    if (anthropic) {
      const p = await get("https://api.anthropic.com/api/oauth/profile").catch(
        () => null,
      );
      const profile: unknown = p?.ok ? await p.json().catch(() => null) : null;
      const org =
        isRecord(profile) && isRecord(profile.organization)
          ? profile.organization
          : null;
      if (org)
        body.subscription = {
          plan:
            typeof org.organization_type === "string"
              ? org.organization_type
              : null,
          status:
            typeof org.subscription_status === "string"
              ? org.subscription_status
              : null,
          since:
            typeof org.subscription_created_at === "string"
              ? org.subscription_created_at
              : null,
        };
    }
    body.updatedAt = Date.now();
    try {
      record(body, body.updatedAt);
    } catch (err) {
      console.error("usage history not saved:", err);
    }
    return { body };
  } catch {
    return {
      error:
        "Could not read provider usage (network error or invalid response)",
    };
  }
}

export function fetchUsage(provider = defaultUsageProvider()): Promise<Result> {
  if (
    provider !== "anthropic" &&
    provider !== "pi-sub-anthropic" &&
    provider !== "openai-codex"
  )
    return requestUsage(provider);
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.result);
  const pending = inFlight.get(provider);
  if (pending) return pending;
  const work = requestUsage(provider)
    .then((result) => {
      const good = "body" in result ? result.body : hit?.good;
      if ("error" in result && good)
        result = { body: { ...good, stale: true } };
      cache.set(provider, { at: Date.now(), result, good });
      return result;
    })
    .finally(() => inFlight.delete(provider));
  inFlight.set(provider, work);
  return work;
}

export function pollUsage(): void {
  setInterval(() => void fetchUsage().catch(() => {}), POLL_MS).unref();
}
