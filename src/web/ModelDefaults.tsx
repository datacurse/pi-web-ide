import { useState } from "react";
import { api, unwrap } from "./api.js";
import { Button, inputClass } from "./ui.js";
import { modelDefaultsChanged, useModelDefaults } from "./useModelDefaults.js";

export function ModelDefaults({ open }: { open: boolean }) {
  const defaults = useModelDefaults(open);
  return <ModelDefaultsPanel defaults={defaults} />;
}

/** Machine-wide Pi defaults, not credentials or the active chat's model. */
export function ModelDefaultsPanel({
  defaults: { data, loading, error, refresh },
  disabled = false,
}: {
  defaults: ReturnType<typeof useModelDefaults>;
  disabled?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [status, setStatus] = useState("");
  const busy = disabled || loading || saving || !data;
  const providers = [
    ...new Set(data?.models.map((m) => m.split("/")[0]) ?? []),
  ].sort();
  const save = async (request: () => Promise<unknown>) => {
    setSaving(true);
    setSaveError("");
    setStatus("");
    try {
      await request();
      modelDefaultsChanged();
      setStatus(
        "Saved. New conversations use this default; existing chats are unchanged.",
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-label="Model defaults" className="flex flex-col gap-3">
      <div>
        <h2 className="text-title font-medium">Model defaults</h2>
        <p className="mt-1 text-meta text-neutral-500">
          These settings choose the provider and model for new conversations.
          Signing in does not make a provider the default. Existing chats keep
          their own model; trusted project settings can override these defaults.
        </p>
      </div>
      {data && (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui">
            <dt className="text-neutral-400">Saved default provider</dt>
            <dd className="min-w-0 break-words font-mono text-amber-400">
              {data.defaultProvider ?? "Automatic (Pi chooses)"}
            </dd>
            <dt className="text-neutral-400">Saved default model</dt>
            <dd className="min-w-0 break-words font-mono">
              {data.default?.slice(data.default.indexOf("/") + 1) ??
                "Automatic (Pi chooses)"}
            </dd>
          </dl>
          {data.startupOverride && (
            <p role="status" className="text-meta text-amber-400">
              {`This app starts new conversations with ${data.startupOverride} because PWI_MODEL is set. That server override takes precedence over the saved model. Change PWI_MODEL and restart the server to remove it.`}
            </p>
          )}
          <label className="text-ui">
            Default provider / model
            <select
              className={`mt-1 w-full font-mono ${inputClass.sm}`}
              value={data.default ?? ""}
              disabled={busy}
              onChange={(e) => {
                const model = e.target.value || null;
                void save(() =>
                  unwrap(api["default-model"].$post({ json: { model } })),
                );
              }}
            >
              <option value="">Automatic — let Pi choose</option>
              {data.default && !data.models.includes(data.default) && (
                <option value={data.default} disabled>
                  {data.default} (unavailable)
                </option>
              )}
              {providers.map((provider) => (
                <optgroup key={provider} label={provider}>
                  {data.models
                    .filter((m) => m.startsWith(`${provider}/`))
                    .map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label className="text-ui">
            Default reasoning
            <select
              className={`mt-1 w-full ${inputClass.sm}`}
              value={data.defaultThinking ?? ""}
              disabled={busy}
              onChange={(e) => {
                const level = e.target.value || null;
                void save(() =>
                  unwrap(api["default-thinking"].$post({ json: { level } })),
                );
              }}
            >
              <option value="">Automatic — use Pi's default</option>
              {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
                (level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ),
              )}
            </select>
            <span className="mt-1 block text-meta text-neutral-500">
              Pi adjusts unsupported reasoning levels to the selected model's
              capabilities.
            </span>
          </label>
          <label className="text-ui">
            Default speed
            <select
              className={`mt-1 w-full ${inputClass.sm}`}
              value={
                data.defaultFast === null ? "" : data.defaultFast ? "on" : "off"
              }
              disabled={busy}
              onChange={(e) => {
                const enabled =
                  e.target.value === "" ? null : e.target.value === "on";
                void save(() =>
                  unwrap(api["default-fast-mode"].$post({ json: { enabled } })),
                );
              }}
            >
              <option value="">
                Automatic — Standard unless configured otherwise
              </option>
              <option value="off">Standard</option>
              <option value="on">Fast — may use more quota</option>
            </select>
            <span className="mt-1 block text-meta text-neutral-500">
              Applies to supported models in new Piwi chats. PCC has separate
              Fast Mode controls under /codex.
            </span>
          </label>
          <p className="text-meta text-neutral-500">
            Saved immediately on this machine in{" "}
            <code className="break-all font-mono">{data.settingsPath}</code>.
            These are Pi's own defaults, shared with terminal Pi. Background
            automation models are configured separately under Automation.
          </p>
        </>
      )}
      {loading && !data && (
        <p className="text-meta text-neutral-500">Loading model defaults…</p>
      )}
      {(error || saveError) && (
        <p role="alert" className="text-meta text-red-400">
          {error || saveError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={loading || saving}
          onClick={refresh}
        >
          {loading ? "Refreshing…" : "Refresh defaults"}
        </Button>
        {status && (
          <p role="status" className="text-meta text-neutral-400">
            {status}
          </p>
        )}
      </div>
    </section>
  );
}
