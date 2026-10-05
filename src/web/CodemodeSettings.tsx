import { useEffect, useState } from "react";
import { api, unwrap } from "./api.js";
import { Button, OptionRow } from "./ui.js";
import { t } from "./i18n.js";

type Mode = "off" | "on" | "only";
const MODES: { mode: Mode; label: string; hint: string }[] = [
  {
    mode: "off",
    label: "Off",
    hint: "Do not expose pi’s native codemode tool. Recommended when using the Pi Codex extension.",
  },
  {
    mode: "on",
    label: "Codemode and individual tools",
    hint: "Let the agent run JavaScript to call several tools, or call individual tools directly.",
  },
  {
    mode: "only",
    label: "Codemode only",
    hint: "Require the agent to call tools through JavaScript in native codemode.",
  },
];

export function CodemodeSettings({ open }: { open: boolean }) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    try {
      const body = await unwrap(
        api["native-codemode"].$get(
          {},
          {
            init: { signal: AbortSignal.timeout(15_000) },
          },
        ),
      );
      setMode(body.mode);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (open) void load();
  }, [open]);
  const save = async (next: Mode) => {
    setBusy(true);
    try {
      const body = await unwrap(
        api["native-codemode"].$put({ json: { mode: next } }),
      );
      setMode(body.mode);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="radiogroup" aria-label={t("Native codemode")}>
      <p className="px-2 pb-2 text-meta text-neutral-500">
        {t(
          "Codemode lets the agent call tools from JavaScript, including batching calls. This is pi’s built-in tool, not the Pi Codex extension’s Code/Notebook modes. Saved on this machine; project settings may override it. Applies to new sessions; restart existing sessions to apply.",
        )}
      </p>
      {MODES.map((option) => (
        <OptionRow key={option.mode} selected={mode === option.mode}>
          <input
            type="radio"
            name="nativeCodemode"
            checked={mode === option.mode}
            disabled={mode === null || busy}
            onChange={() => void save(option.mode)}
            className="size-3.5 shrink-0 accent-amber-400"
          />
          <span className="flex-1">
            {t(option.label)}
            <span className="block text-meta text-neutral-500">
              {t(option.hint)}
            </span>
          </span>
        </OptionRow>
      ))}
      {error && (
        <div className="px-2 text-ui text-red-400" role="alert">
          {error}
          <Button variant="subtle" disabled={busy} onClick={() => void load()}>
            {t("Retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
