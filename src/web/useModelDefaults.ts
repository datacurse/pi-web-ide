import { useEffect, useState } from "react";
import { api, unwrap } from "./api.js";

const DEFAULTS_CHANGED = "pwi:model-defaults-changed";

/** Keep settings, authentication and the composer's default stars in sync. */
export function modelDefaultsChanged() {
  window.dispatchEvent(new Event(DEFAULTS_CHANGED));
}

export function onModelDefaultsChanged(refresh: () => void) {
  window.addEventListener(DEFAULTS_CHANGED, refresh);
  return () => window.removeEventListener(DEFAULTS_CHANGED, refresh);
}

function loadDefaults(signal: AbortSignal) {
  return unwrap(api.models.$get({}, { init: { signal } }));
}

export function useModelDefaults(active: boolean) {
  const [data, setData] = useState<Awaited<
    ReturnType<typeof loadDefaults>
  > | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!active) return;
    const refresh = () => setAttempt((n) => n + 1);
    const unsubscribe = onModelDefaultsChanged(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setError("");
    void loadDefaults(controller.signal)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(
            controller.signal.aborted
              ? "Loading model defaults timed out. Try again."
              : err instanceof Error
                ? err.message
                : String(err),
          );
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [active, attempt]);

  return { data, error, loading, refresh: () => setAttempt((n) => n + 1) };
}
