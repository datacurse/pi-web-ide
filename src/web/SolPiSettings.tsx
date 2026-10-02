/**
 * SolPiSettings.tsx — SoL-Pi's `sol-pi.json`, opened from its row in Packages.
 *
 * Switches and the reducer model save on pick; the ratio has its own button.
 * Each mechanism's own settings show only while it is on. The file is read at pi startup, so a change applies to
 * sessions started afterwards.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import type {
  SolPiConfig,
  SolPiSettings as Settings,
} from "../shared/types.js";
import { Button, OptionRow, inputClass } from "./ui.js";
import { api } from "./api.js";
import { t } from "./i18n.js";

type Flag =
  | "actionFusion"
  | "observationPack"
  | "evidencePreservingReducer"
  | "onlineContextCompact";

const FLAGS: { key: Flag; name: () => string; hint: () => string }[] = [
  {
    key: "actionFusion",
    name: () => t("Action Fusion"),
    hint: () =>
      t(
        "An edit or write can run its follow-up check (tests, lint, build) in the same tool call, saving a model turn. Local.",
      ),
  },
  {
    key: "observationPack",
    name: () => t("ObservationPack"),
    hint: () =>
      t(
        "Large outputs that keep being re-sent become a short handle the model can page back through. The full text is archived in the session directory and never deleted automatically.",
      ),
  },
  {
    key: "evidencePreservingReducer",
    name: () => t("Evidence-Preserving Reducer"),
    hint: () =>
      t(
        "A test or build log over 4 KB is summarised by the reducer model, kept only if every quoted line matches the original. pi waits for that call, so each such log takes a few seconds longer. Sends log contents to that model.",
      ),
  },
  {
    key: "onlineContextCompact",
    name: () => t("Online Context Compact"),
    hint: () =>
      t(
        "Compacts the conversation when a plan step finishes and it pays off or the window is filling, then continues on its own.",
      ),
  },
];

import { DEFAULT_AUTOMATIC_MODEL } from "../shared/automaticModels.js";

const ratioText = (c: SolPiConfig) =>
  c.cacheWriteReadRatio === undefined ? "" : String(c.cacheWriteReadRatio);

export function SolPiSettings({ cwd }: { cwd: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  /** Every model pi can reach, as "provider/id"; null until loaded. */
  const [models, setModels] = useState<string[] | null>(null);
  const [ratio, setRatio] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.packages["sol-pi"]
      .$get({ query: { cwd } })
      .then(async (r) => {
        const body = (await r.json()) as Settings | { error: string };
        if ("error" in body) return setError(body.error);
        setSettings(body);
        setRatio(ratioText(body.config));
        setError(null);
      })
      .catch(() => setError(t("could not load the settings")));
  }, [cwd]);

  useEffect(() => {
    void api.models
      .$get()
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setModels(d && "models" in d ? d.models : []))
      .catch(() => setModels([]));
  }, []);

  const save = async (change: Record<string, unknown>): Promise<boolean> => {
    const r = await api.packages["sol-pi"]
      .$put({ query: { cwd }, json: change })
      .catch(() => null);
    const body = (await r?.json().catch(() => null)) as
      Settings | { error: string } | null;
    if (!r?.ok || !body || "error" in body) {
      setError(
        body && "error" in body ? body.error : t("could not save the setting"),
      );
      return false;
    }
    setSettings(body);
    setError(null);
    return true;
  };

  /** The same reducer route shown in Settings > Automatic actions. */
  const saveReducer = (selector: string) => {
    const slash = selector.indexOf("/");
    void save({
      evidencePreservingReducerProvider: selector
        ? selector.slice(0, slash)
        : null,
      evidencePreservingReducerModel: selector
        ? selector.slice(slash + 1)
        : null,
    });
  };

  const saveRatio = async () => {
    const text = ratio.trim();
    if (text && !(Number(text) >= 0))
      return setError(t("the ratio must be a number, 0 or more"));
    if (await save({ cacheWriteReadRatio: text ? Number(text) : null }))
      setRatio(text);
  };

  const c = settings?.config;
  const reducer =
    c?.evidencePreservingReducerProvider && c.evidencePreservingReducerModel
      ? `${c.evidencePreservingReducerProvider}/${c.evidencePreservingReducerModel}`
      : DEFAULT_AUTOMATIC_MODEL;
  const providers = [
    ...new Set((models ?? []).map((m) => m.split("/")[0])),
  ].sort();
  const dirty = c !== undefined && ratio.trim() !== ratioText(c);

  return (
    <div className="max-w-xl pb-3">
      {settings?.projectFile && (
        <p className="mb-2 rounded-sm border border-amber-900 bg-amber-950/30 px-2 py-1.5 text-meta text-amber-300">
          {t("{path} replaces these settings while this project is trusted.", {
            path: settings.projectFile,
          })}
        </p>
      )}
      {FLAGS.map((f) => (
        <Fragment key={f.key}>
          <OptionRow disabled={!settings}>
            <input
              type="checkbox"
              checked={c?.[f.key] ?? false}
              disabled={!settings}
              onChange={(e) => void save({ [f.key]: e.target.checked })}
              className="size-4 shrink-0 accent-amber-400"
            />
            <span className="flex-1">
              {f.name()}
              <span className="block text-meta text-neutral-500">
                {f.hint()}
              </span>
            </span>
          </OptionRow>
          {f.key === "evidencePreservingReducer" &&
            c?.evidencePreservingReducer && (
              <Nested>
                <label className="block text-meta text-neutral-500">
                  {t("Reducer model")}
                  <select
                    value={reducer}
                    disabled={models === null}
                    onChange={(e) => saveReducer(e.target.value)}
                    className={`mt-1 w-full font-mono ${inputClass.sm}`}
                  >
                    {reducer && !models?.includes(reducer) && (
                      <option value={reducer} disabled>
                        {reducer}
                      </option>
                    )}
                    {providers.map((p) => (
                      <optgroup key={p} label={p}>
                        {(models ?? [])
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
              </Nested>
            )}
          {f.key === "onlineContextCompact" && c?.onlineContextCompact && (
            <Nested>
              <label className="block text-meta text-neutral-500">
                {t("Cache write/read cost ratio")}
                <span className="block">
                  {t(
                    "Used by Online Context Compact to judge when compacting pays off.",
                  )}
                </span>
                <span className="mt-1 flex gap-2">
                  <input
                    value={ratio}
                    onChange={(e) => setRatio(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void saveRatio()}
                    placeholder="12.5"
                    inputMode="decimal"
                    className={`w-24 font-mono ${inputClass.sm}`}
                  />
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => void saveRatio()}
                    disabled={!dirty}
                  >
                    {t("Save")}
                  </Button>
                </span>
              </label>
            </Nested>
          )}
        </Fragment>
      ))}
      <p className="mt-2 px-2 text-meta break-all text-neutral-500">
        {error ? (
          <span className="text-red-400">{error}</span>
        ) : settings ? (
          t("{path}. Applies to sessions started from now on.", {
            path: settings.path,
          })
        ) : (
          t("loading…")
        )}
      </p>
    </div>
  );
}

/** A control that belongs to the checkbox above it, lined up with that checkbox's text. */
export function Nested({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3 px-2 pb-2">
      <span className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
