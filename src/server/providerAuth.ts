/**
 * Pi's login API, not a second credential store. Sessions still run in isolated
 * CLI children; only provider setup uses the SDK, loaded when the page opens.
 * Inspired by PiChamber's provider login/status/respond workflow.
 */
import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthProvider, ProviderLogin } from "../shared/providerAuth.js";
import { invalidateModels } from "./models.js";

type Interaction = Parameters<ModelRuntime["login"]>[2];
type Prompt = Parameters<Interaction["prompt"]>[0];
type Event = Parameters<Interaction["notify"]>[0];

let runtime: Promise<ModelRuntime> | undefined;
function models() {
  runtime ??= import("@earendil-works/pi-coding-agent")
    .then(({ ModelRuntime }) => ModelRuntime.create({ refreshOnCreate: false }))
    .catch((err) => {
      runtime = undefined;
      throw err;
    });
  return runtime;
}

interface Flow {
  view: ProviderLogin;
  controller: AbortController;
  answer?: (value: string) => void;
  timer: ReturnType<typeof setTimeout>;
}
const flows = new Map<string, Flow>();

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export async function authProviders(): Promise<AuthProvider[]> {
  const m = await models();
  const stored = new Map(
    (await m.listCredentials()).map((c) => [c.providerId, c.type]),
  );
  return m
    .getProviders()
    .map((p) => ({
      id: p.id,
      name: p.name,
      stored: stored.get(p.id) ?? null,
      methods: [
        ...(p.auth?.oauth
          ? [
              {
                type: "oauth" as const,
                label: p.auth.oauth.loginLabel ?? p.auth.oauth.name,
              },
            ]
          : []),
        ...(p.auth?.apiKey?.login
          ? [{ type: "api_key" as const, label: p.auth.apiKey.name }]
          : []),
      ],
    }))
    .filter((p) => p.methods.length || p.stored)
    .sort(
      (a, b) =>
        Number(!!b.stored) - Number(!!a.stored) || a.name.localeCompare(b.name),
    );
}

export function loginStatus(id: string): ProviderLogin {
  const flow = flows.get(id);
  if (!flow)
    throw new HTTPException(404, { message: "Login expired. Start again." });
  return flow.view;
}

function promptFor(flow: Flow, prompt: Prompt): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const signals = [flow.controller.signal, prompt.signal].filter(
      (s): s is AbortSignal => !!s,
    );
    const cleanup = () => {
      for (const signal of signals) signal.removeEventListener("abort", abort);
      if (flow.view.prompt?.id === id) delete flow.view.prompt;
      flow.answer = undefined;
    };
    const abort = () => {
      cleanup();
      reject(new Error("Login prompt cancelled"));
    };
    if (signals.some((s) => s.aborted)) return abort();
    flow.view.prompt = {
      id,
      type: prompt.type,
      message: prompt.message,
      ...("placeholder" in prompt ? { placeholder: prompt.placeholder } : {}),
      ...(prompt.type === "select"
        ? { options: prompt.options.map((o) => ({ ...o })) }
        : {}),
    };
    flow.answer = (value) => {
      cleanup();
      resolve(value);
    };
    for (const signal of signals)
      signal.addEventListener("abort", abort, { once: true });
  });
}

function notify(flow: Flow, event: Event) {
  if (event.type === "auth_url") {
    flow.view.url = safeUrl(event.url);
    flow.view.message = event.instructions;
  } else if (event.type === "device_code") {
    flow.view.url = safeUrl(event.verificationUri);
    flow.view.userCode = event.userCode;
  } else {
    flow.view.message = event.message;
    if (event.type === "info" && event.links?.[0])
      flow.view.url = safeUrl(event.links[0].url);
  }
}

export async function startLogin(provider: string, type: "oauth" | "api_key") {
  const m = await models();
  const p = m.getProvider(provider);
  if (!p || !(type === "oauth" ? p.auth?.oauth : p.auth?.apiKey?.login))
    throw new HTTPException(400, {
      message: "Unsupported provider or login method",
    });
  if (
    [...flows.values()].some(
      (f) => f.view.provider === provider && f.view.state === "pending",
    )
  )
    throw new HTTPException(409, {
      message:
        "A login for this provider is already open. Finish or cancel it first.",
    });
  if (flows.size >= 16)
    throw new HTTPException(429, {
      message: "Too many login attempts. Try again shortly.",
    });

  const id = randomUUID();
  const controller = new AbortController();
  const flow: Flow = {
    view: { id, provider, state: "pending" },
    controller,
    timer: setTimeout(() => {
      controller.abort();
      flows.delete(id);
    }, 10 * 60_000),
  };
  flow.timer.unref();
  flows.set(id, flow);
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  // Never serialize the returned credential or an upstream error containing secrets.
  void m
    .login(
      provider,
      type,
      {
        signal: controller.signal,
        prompt: (prompt) => promptFor(flow, prompt),
        notify: (event) => notify(flow, event),
      },
      {
        getDeviceId: () =>
          SettingsManager.create(process.cwd()).getOrCreateDeviceId(),
      },
    )
    .then(() => {
      invalidateModels();
      flow.view = {
        id,
        provider,
        state: "complete",
        message: "Signed in. New sessions will use this credential.",
      };
    })
    .catch(() => {
      flow.view = {
        id,
        provider,
        state: controller.signal.aborted ? "cancelled" : "failed",
        message: controller.signal.aborted
          ? "Login cancelled."
          : "Login failed. Please try again.",
      };
    })
    .finally(() => {
      clearTimeout(flow.timer);
      flow.timer = setTimeout(() => flows.delete(id), 60_000);
      flow.timer.unref();
    });
  return flow.view;
}

export function answerLogin(id: string, promptId: string, value: string) {
  const flow = flows.get(id);
  const prompt = flow?.view.prompt;
  if (
    !flow ||
    flow.view.state !== "pending" ||
    !flow.answer ||
    prompt?.id !== promptId
  )
    throw new HTTPException(409, {
      message: "This login prompt is no longer waiting.",
    });
  if (prompt.type === "select" && !prompt.options?.some((o) => o.id === value))
    throw new HTTPException(400, { message: "Invalid choice" });
  // Pi supports !shell-command key references; browser-entered secrets must be literal.
  if (prompt.type === "secret" && value.trim().startsWith("!"))
    throw new HTTPException(400, {
      message: "Enter a literal key, not a command reference.",
    });
  flow.answer(value);
  return flow.view;
}

export function cancelLogin(id: string) {
  const flow = flows.get(id);
  if (flow?.view.state === "pending") {
    flow.view.state = "cancelled";
    flow.controller.abort();
  }
}

export async function logoutProvider(provider: string) {
  if (!(await models()).getProvider(provider))
    throw new HTTPException(400, { message: "Unknown provider" });
  for (const flow of flows.values())
    if (flow.view.provider === provider && flow.view.state === "pending")
      cancelLogin(flow.view.id);
  await (await models()).logout(provider);
  invalidateModels();
}
