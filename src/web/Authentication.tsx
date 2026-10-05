import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, Key } from "@phosphor-icons/react";
import type {
  AuthProvider,
  LoginPrompt,
  ProviderLogin,
} from "../shared/providerAuth.js";
import { api, unwrap } from "./api.js";
import { Button, IconButton, inputClass, NavItem, PanelHeader } from "./ui.js";
import { ScrollPane } from "./OverlayScrollbar.js";
import { t } from "./i18n.js";

function PromptForm({
  prompt,
  busy,
  submit,
}: {
  prompt: LoginPrompt;
  busy: boolean;
  submit: (value: string) => void;
}) {
  const [value, setValue] = useState(prompt.options?.[0]?.id ?? "");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
    >
      <label htmlFor={prompt.id} className="text-body">
        {prompt.message}
      </label>
      {prompt.type === "select" ? (
        <select
          id={prompt.id}
          className={inputClass.md}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        >
          {prompt.options?.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={prompt.id}
          className={inputClass.md}
          type={prompt.type === "secret" ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          placeholder={prompt.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          autoFocus
        />
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={busy || !value.trim()}
        className="self-start"
      >
        {t("Continue")}
      </Button>
    </form>
  );
}

/** Provider credentials for this machine, shared with terminal Pi. Not an IDE access password. */
export function Authentication({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [selected, setSelected] = useState("");
  const [login, setLogin] = useState<ProviderLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const current = useRef<ProviderLogin | null>(null);
  current.current = login;
  const visible = useRef(open);
  visible.current = open;
  const acceptLogin = async (flow: ProviderLogin) => {
    if (visible.current) setLogin(flow);
    else if (flow.state === "pending")
      await unwrap(api.auth.login[":id"].$delete({ param: { id: flow.id } }));
  };

  const refresh = useCallback(async () => {
    const data = await unwrap(api.auth.providers.$get());
    setProviders(data.providers);
    setSelected((id) =>
      data.providers.some((p) => p.id === id)
        ? id
        : (data.providers[0]?.id ?? ""),
    );
    setLoaded(true);
  }, []);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open) {
      void refresh().catch((err: Error) => setError(err.message));
    } else {
      const flow = current.current;
      if (flow?.state === "pending")
        void api.auth.login[":id"]
          .$delete({ param: { id: flow.id } })
          .catch(() => {});
      setLogin(null);
    }
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !login || login.state !== "pending") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = login.id;
    const poll = async () => {
      try {
        const data = await unwrap(
          api.auth.login[":id"].$get({ param: { id } }),
        );
        if (stopped) return;
        setLogin(data.login);
        setError("");
        if (data.login.state === "complete") await refresh();
        if (data.login.state !== "pending") return;
      } catch (err) {
        if (!stopped)
          setError(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 300);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, login?.id, login?.state, refresh]);

  const provider = providers.find((p) => p.id === selected);
  const codexLogin = providers.find((p) => p.id === "openai-codex" && p.stored);
  const pending = login?.state === "pending";
  const cancel = async () => {
    if (login)
      await unwrap(api.auth.login[":id"].$delete({ param: { id: login.id } }));
    setLogin(null);
  };

  return (
    <>
      <PanelHeader title={t("Authentication")} onClose={onClose}>
        <IconButton
          label={t("Refresh")}
          disabled={busy}
          onClick={() => void act(refresh)}
        >
          <ArrowClockwise size={16} />
        </IconButton>
      </PanelHeader>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <ScrollPane className="max-h-48 w-full shrink-0 border-b border-neutral-800 p-3 sm:max-h-none sm:w-60 sm:border-r sm:border-b-0">
          <div className="flex flex-col gap-1">
            {providers.map((p) => (
              <NavItem
                key={p.id}
                title={
                  p.stored
                    ? t("Saved credential: {type}", {
                        type: p.stored === "oauth" ? "OAuth" : "API key",
                      })
                    : undefined
                }
                icon={
                  p.stored ? (
                    <CheckCircle size={16} className="text-green-400" />
                  ) : (
                    <Key size={16} />
                  )
                }
                selected={p.id === selected}
                disabled={busy || !!pending}
                onClick={() => {
                  setSelected(p.id);
                  setLogin(null);
                  setError("");
                }}
              >
                {p.name}
              </NavItem>
            ))}
          </div>
        </ScrollPane>
        <ScrollPane className="min-w-0 flex-1 p-6">
          <div className="flex max-w-xl flex-col gap-4">
            <p className="text-meta text-neutral-500">
              {t(
                "Sign in to AI providers on this machine. Credentials are saved in Pi’s auth.json and shared with terminal Pi. This does not protect access to the IDE.",
              )}
            </p>
            <p className="text-meta text-neutral-500">
              {t(
                "This page lists built-in and models.json providers. For providers supplied by extensions, use /login in terminal Pi.",
              )}
            </p>
            {error && (
              <p role="alert" className="text-body text-red-400">
                {error}
              </p>
            )}
            {!loaded && !error && (
              <p className="text-meta text-neutral-500">
                {t("Loading providers…")}
              </p>
            )}
            {loaded && !provider && (
              <p className="text-body text-neutral-400">
                {t("No providers available.")}
              </p>
            )}
            {provider && (
              <>
                <h2 className="text-title font-medium">{provider.name}</h2>
                <p className="text-meta text-neutral-400">
                  {provider.stored
                    ? t("Already connected · saved credential: {type}", {
                        type: provider.stored === "oauth" ? "OAuth" : "API key",
                      })
                    : t(
                        "No saved credential. Environment or cloud credentials may still be available.",
                      )}
                </p>
                {provider.id === "openai" && !provider.stored && codexLogin && (
                  <div className="flex flex-col gap-2">
                    <p className="text-body text-neutral-300">
                      {t(
                        "You already have a saved login for {provider}. OpenAI and OpenAI Codex use separate credentials; you do not need to sign in here to keep using Codex.",
                        { provider: codexLogin.name },
                      )}
                    </p>
                    <Button
                      className="self-start"
                      disabled={busy || !!pending}
                      onClick={() => {
                        setSelected(codexLogin.id);
                        setLogin(null);
                        setError("");
                      }}
                    >
                      {t("View existing login")}
                    </Button>
                  </div>
                )}
                {!pending && (
                  <div className="flex flex-wrap gap-2">
                    {provider.methods.map((method, index) => (
                      <Button
                        key={method.type}
                        variant={index === 0 ? "primary" : "secondary"}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const data = await unwrap(
                              api.auth.login.$post({
                                json: {
                                  provider: provider.id,
                                  type: method.type,
                                },
                              }),
                            );
                            await acceptLogin(data.login);
                          })
                        }
                      >
                        {method.type === "oauth"
                          ? method.label
                          : t("Set API key")}
                      </Button>
                    ))}
                    {provider.stored && (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              t(
                                "Remove this provider’s saved credential? This does not revoke it or remove environment credentials.",
                              ),
                            )
                          )
                            void act(async () => {
                              await unwrap(
                                api.auth.logout.$post({
                                  json: { provider: provider.id },
                                }),
                              );
                              setLogin(null);
                              await refresh();
                            });
                        }}
                      >
                        {t("Log out")}
                      </Button>
                    )}
                  </div>
                )}
                {login && (
                  <div className="flex flex-col gap-3" aria-live="polite">
                    {login.message && (
                      <p
                        className={
                          login.state === "failed"
                            ? "text-body text-red-400"
                            : "text-body text-neutral-300"
                        }
                      >
                        {login.message}
                      </p>
                    )}
                    {pending && login.url && (
                      <a
                        href={login.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-body text-amber-400 underline"
                      >
                        {t("Open provider sign-in")}
                      </a>
                    )}
                    {pending && login.userCode && (
                      <p className="text-body">
                        {t("Device code")}:{" "}
                        <code className="font-mono text-amber-400">
                          {login.userCode}
                        </code>
                      </p>
                    )}
                    {pending && login.prompt && (
                      <PromptForm
                        key={login.prompt.id}
                        prompt={login.prompt}
                        busy={busy}
                        submit={(value) => {
                          const prompt = login.prompt!;
                          void act(async () => {
                            const data = await unwrap(
                              api.auth.login[":id"].$post({
                                param: { id: login.id },
                                json: { prompt: prompt.id, value },
                              }),
                            );
                            await acceptLogin(data.login);
                          });
                        }}
                      />
                    )}
                    {pending && !login.prompt && (
                      <p className="text-meta text-neutral-500">
                        {t("Waiting for provider sign-in…")}
                      </p>
                    )}
                    {pending && (
                      <Button
                        disabled={busy}
                        className="self-start"
                        onClick={() => void act(cancel)}
                      >
                        {t("Cancel login")}
                      </Button>
                    )}
                    {login.state === "complete" && (
                      <p className="text-meta text-neutral-500">
                        {t(
                          "Start a new AI session to pick up the credential. Existing sessions may need to be reopened.",
                        )}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollPane>
      </div>
    </>
  );
}
