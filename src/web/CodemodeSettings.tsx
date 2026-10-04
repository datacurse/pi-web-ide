import { useEffect, useState } from "react";
import { api, unwrap } from "./api.js";
import { Button, OptionRow } from "./ui.js";
import { t } from "./i18n.js";

type Mode = "off" | "on" | "only";
const MODES: { mode: Mode; label: string; hint: string }[] = [
  {
    mode: "off",
    label: "Off",
    hint: "Recommended with the Pi Codex extension.",
  },
  {
    mode: "on",
    label: "On",
    hint: "Expose native codemode alongside ordinary tools.",
  },
  {
    mode: "only",
    label: "Only",
    hint: "Use native codemode as the tool entry point.",
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
          "Pi's native codemode, separate from the Codex extension's Code/Notebook modes. Machine-wide default; project settings may override it. Applies to new sessions; restart existing sessions to apply.",
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
