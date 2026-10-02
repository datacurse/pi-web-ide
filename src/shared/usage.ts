export interface UsageLimit {
  kind: string;
  group?: string;
  percent: number;
  resets_at: string | null;
  windowMs?: number;
  /** Observed start after an early reset, rather than the scheduled window start. */
  startedAt?: number;
  scope: { model?: { display_name?: string | null } } | null;
}

export interface UsageSubscription {
  plan: string | null;
  status: string | null;
  since: string | null;
}

export interface ProviderUsage {
  provider: string;
  limits: UsageLimit[];
  subscription: UsageSubscription | null;
  message?: string;
  updatedAt?: number;
  stale?: boolean;
}

export function providerLabel(provider: string): string {
  if (provider === "openai-codex") return "OpenAI (ChatGPT)";
  if (provider === "openai") return "OpenAI API";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "pi-sub-anthropic") return "Anthropic (pi-sub)";
  return provider;
}
