import { useEffect, useState } from "react";
import {
  AUTOMATIC_ACTIONS,
  DEFAULT_AUTOMATIC_MODEL,
  type AutomaticAction,
  type AutomaticModels,
} from "../shared/automaticModels.js";
import { api } from "./api.js";
import { Button, inputClass, OptionRow } from "./ui.js";
import { t } from "./i18n.js";

const LABELS: Record<AutomaticAction, string> = {
  commitNaming: "Commit message model",
  sessionNaming: "Session title model",
  compaction: "Conversation summary model",
  reducer: "Tool log reduction model",
};

const HINTS: Record<AutomaticAction, string> = {
  commitNaming: "Generates commit messages for the commit action.",
  sessionNaming: "Generates session names when you request an AI title.",
  compaction:
    "Summarizes conversation history to free context space. Used for manual, automatic, and SoL-Pi online compaction in sessions started with the compaction extension.",
  reducer:
    "Shortens tool logs through SoL-Pi. Applies to new sessions; trusted projects can override this model. Enable log reduction in Packages → SoL-Pi.",
};

export function AutomaticActions() {
  const [models, setModels] = useState<string[]>([]);
  const [selected, setSelected] = useState<AutomaticModels | null>(null);
  const [autoCompaction, setAutoCompaction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    try {
      const r = await api["automatic-models"].$get(
        { query: {} },
        { init: { signal: AbortSignal.timeout(15_000) } },
      );
      const body = await r.json();
      if ("error" in body) throw new Error(body.error);
      setModels(body.models);
      setSelected(body.selected);
      setAutoCompaction(body.autoCompaction);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const save = async (action: AutomaticAction, model: string) => {
    setBusy(true);
    try {
      const r = await api["automatic-models"].$put({
        query: {},
        json: { action, model },
      });
      const body = await r.json();
      if ("error" in body) throw new Error(body.error);
      setSelected(body.selected);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const saveAutoCompaction = async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await api["auto-compaction"].$put({ json: { enabled } });
      const body = await r.json();
      if ("error" in body) throw new Error(body.error);
      setAutoCompaction(body.autoCompaction);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const providers = [...new Set(models.map((m) => m.split("/")[0]))].sort();
  return (
    <div className="flex flex-col gap-4">
      <OptionRow>
        <input
          type="checkbox"
          checked={autoCompaction}
          disabled={!selected || busy}
          onChange={(e) => void saveAutoCompaction(e.target.checked)}
          className="size-4 shrink-0 accent-amber-400"
        />
        <span className="flex-1">
          {t("Summarize when context is full")}
          <span className="block text-meta text-neutral-500">
            {t(
              "Automatically summarize older messages when the conversation reaches its context limit. Off by default. Applies to open and new sessions; you can still compact manually when this is off.",
            )}
          </span>
        </span>
      </OptionRow>
      <p className="text-meta text-neutral-500">
        {t(
          "Each model selection saves immediately and does not change the chat model. Default for all actions: {model}.",
          { model: DEFAULT_AUTOMATIC_MODEL },
        )}
      </p>
      {AUTOMATIC_ACTIONS.map((action) => {
        const value = selected?.[action] ?? DEFAULT_AUTOMATIC_MODEL;
        return (
          <label key={action} className="block text-ui">
            {t(LABELS[action])}
            <span className="mt-1 block text-meta text-neutral-500">
              {t(HINTS[action])}
            </span>
            <select
              value={value}
              disabled={!selected || busy}
              onChange={(e) => void save(action, e.target.value)}
              className={`mt-1 w-full font-mono ${inputClass.sm}`}
            >
              {!models.includes(value) && (
                <option value={value} disabled>
                  {value}
                </option>
              )}
              {providers.map((p) => (
                <optgroup key={p} label={p}>
                  {models
                    .filter((m) => m.startsWith(`${p}/`))
                    .map((m) => (
                      <option key={m} value={m}>
                        {m.slice(p.length + 1)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
        );
      })}
      <p className="text-meta text-neutral-500">
        {t(
          "Selecting a model does not enable an action. SoL-Pi online compaction and log reduction are enabled separately in Packages.",
        )}
      </p>
      {error && (
        <div className="flex items-center gap-2">
          <p className="text-meta text-red-400">{error}</p>
          <Button size="sm" disabled={busy} onClick={() => void load()}>
            {t("Retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
