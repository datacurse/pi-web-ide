import {
  type SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useId,
  useState,
} from "react";
import { CaretDown, Star } from "@phosphor-icons/react";
import { Button } from "./ui.js";
import { ScrollPane } from "./OverlayScrollbar.js";
import { api } from "./api.js";

import { thinkingChoices } from "../shared/thinking.js";
import { supportsFastMode } from "../shared/fastMode.js";

/** Composer controls with cross-browser startup default stars. */
export function ModelSelector({
  model,
  disabled,
  error,
  onChange,
  thinkingLevel,
  thinkingLevels,
  thinkingLevelMap,
  onThinkingChange,
  fastMode,
  onFastChange,
}: {
  model: string | undefined;
  disabled: boolean;
  /** Surfaced from the last failed switch attempt, if any. */
  error?: string | null;
  onChange: (model: string) => void;
  /** Empty when the model has no reasoning levels; the control then hides. */
  thinkingLevel: string | undefined;
  thinkingLevels: string[];
  thinkingLevelMap?: Record<string, string | null>;
  onThinkingChange: (level: string) => void;
  fastMode?: boolean;
  onFastChange?: (enabled: boolean) => Promise<void>;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  /** pi's saved startup model, so the star shows the truth after a reload or a switch. */
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [defaultThinking, setDefaultThinking] = useState<string | null>(null);
  const [defaultFast, setDefaultFast] = useState<string | null>(null);
  const [fastPending, setFastPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true);
    setCatalogError(null);
    void (async () => {
      try {
        const r = await api.models.$get(
          {},
          { init: { signal: controller.signal } },
        );
        const d = await r.json();
        if (!r.ok || "error" in d) {
          throw new Error("error" in d ? d.error : String(r.status));
        }
        if (cancelled) return;
        if (!d.models?.length)
          throw new Error("No authenticated models available");
        setModels(d.models);
        setDefaultModel(d.default ?? null);
        setDefaultThinking(d.defaultThinking ?? null);
        setDefaultFast(
          d.defaultFast === null ? null : d.defaultFast ? "on" : "off",
        );
      } catch (err) {
        if (!cancelled)
          setCatalogError(
            controller.signal.aborted
              ? "Model list timed out. Retry to reconnect."
              : `Could not load models: ${err instanceof Error ? err.message : String(err)}`,
          );
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  const providers = useMemo(
    () => [...new Set(models.map((m) => m.split("/")[0]))].sort(),
    [models],
  );
  const thinking = thinkingChoices(thinkingLevels, thinkingLevelMap);
  const selectedThinking = thinking.resolve(thinkingLevel) ?? undefined;
  const savedThinking = thinking.resolve(defaultThinking);

  /** Star toggles: save the current value as pi's startup default, or clear it if it already is. */
  const toggleDefault = async (
    save: (
      next: string | null,
    ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
    current: string | null,
    value: string,
    set: (v: string | null) => void,
  ) => {
    const next = current === value ? null : value;
    const r = await save(next);
    if (r.ok) set(next);
    else
      alert(
        `Could not save default: ${
          ((await r.json().catch(() => ({}))) as { error?: string }).error ??
          r.status
        }`,
      );
  };

  return (
    <div className="relative flex items-center gap-0.5">
      <PillPicker
        value={model ?? ""}
        label={model?.split("/").pop() ?? "(no model)"}
        disabled={disabled || models.length === 0}
        title={
          disabled
            ? "Cannot switch models while streaming"
            : loading
              ? "Loading models…"
              : (catalogError ?? model ?? "Switch model")
        }
        what="model"
        groups={providers.map((provider) => ({
          label: provider,
          options: models
            .filter((m) => m.startsWith(`${provider}/`))
            .map((m) => ({ value: m, label: m.slice(provider.length + 1) })),
        }))}
        saved={defaultModel}
        onChange={onChange}
        onDefault={(value) =>
          toggleDefault(
            (model) => api["default-model"].$post({ json: { model } }),
            defaultModel,
            value,
            setDefaultModel,
          )
        }
      />
      {thinking.levels.length > 0 && (
        <PillPicker
          value={selectedThinking ?? ""}
          label={selectedThinking ?? "Reasoning"}
          title="Reasoning effort — applies from the next turn"
          what="reasoning level"
          groups={[
            {
              options: thinking.levels.map((value) => ({
                value,
                label: value,
              })),
            },
          ]}
          saved={savedThinking ?? null}
          onChange={onThinkingChange}
          onDefault={(value) =>
            toggleDefault(
              (level) => api["default-thinking"].$post({ json: { level } }),
              savedThinking ?? null,
              value,
              setDefaultThinking,
            )
          }
        />
      )}
      {supportsFastMode(model) && onFastChange && (
        <PillPicker
          value={fastMode ? "on" : "off"}
          label={
            fastMode
              ? model === "openai-codex/gpt-6.1-sol"
                ? "Fast · 2.5× usage"
                : "Fast"
              : "Standard"
          }
          disabled={disabled || fastPending || fastMode === undefined}
          title={
            fastMode === undefined
              ? "Restart this session to use Fast mode"
              : model === "openai-codex/gpt-6.1-sol"
                ? "Fast mode — uses 2.5× subscription allowance; availability depends on your account"
                : "Fast mode — requests priority service; availability and pricing depend on your provider and account"
          }
          what="speed"
          groups={[
            {
              options: [
                { value: "off", label: "Standard" },
                {
                  value: "on",
                  label:
                    model === "openai-codex/gpt-6.1-sol"
                      ? "Fast · 2.5× usage"
                      : "Fast",
                },
              ],
            },
          ]}
          saved={defaultFast}
          onChange={async (value) => {
            setFastPending(true);
            try {
              await onFastChange(value === "on");
            } finally {
              setFastPending(false);
            }
          }}
          onDefault={(value) =>
            toggleDefault(
              (next) =>
                api["default-fast-mode"].$post({
                  json: { enabled: next === null ? null : next === "on" },
                }),
              defaultFast,
              value,
              setDefaultFast,
            )
          }
        />
      )}
      {catalogError && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setAttempt((n) => n + 1)}
        >
          Retry
        </Button>
      )}
      {(error || catalogError) && (
        <div
          role="alert"
          className="absolute bottom-full right-0 mb-1 w-80 rounded-sm border border-red-900 bg-red-950/80 px-2 py-1 text-meta text-red-300"
        >
          {error || catalogError}
        </div>
      )}
    </div>
  );
}

/** Save a startup default without changing the active selection. */
function DefaultStar({
  what,
  saved,
  onToggle,
}: {
  what: "model" | "reasoning level" | "speed";
  saved: boolean;
  onToggle: () => void;
}) {
  const stop = (e: SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <button
      data-custom="startup default star"
      type="button"
      aria-pressed={saved}
      title={
        what === "model"
          ? saved
            ? "Startup default model — click to clear"
            : "Make this the startup default model"
          : what === "speed"
            ? saved
              ? "Startup default speed — click to clear"
              : "Make this the startup default speed"
            : saved
              ? "Startup default reasoning level — click to clear"
              : "Make this the startup default reasoning level"
      }
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={(e) => {
        stop(e);
        onToggle();
      }}
      className={`inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm ${saved ? "text-amber-400" : "text-neutral-500 hover:text-neutral-300"}`}
    >
      <Star size={13} weight={saved ? "fill" : "regular"} />
    </button>
  );
}

/** Native popovers provide top-layer placement, Escape and outside-click dismissal. */
function PillPicker({
  value,
  label,
  title,
  disabled,
  groups,
  saved,
  what,
  onChange,
  onDefault,
}: {
  value: string;
  label: string;
  title: string;
  disabled?: boolean;
  groups: { label?: string; options: { value: string; label: string }[] }[];
  saved: string | null;
  what: "model" | "reasoning level" | "speed";
  onChange: (value: string) => void;
  onDefault: (value: string) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    left: 0,
    bottom: 0,
    maxHeight: 0,
  });

  useEffect(() => {
    if (disabled) popup.current?.hidePopover();
  }, [disabled]);

  return (
    <>
      <button
        data-custom="composer pill"
        ref={trigger}
        type="button"
        title={title}
        disabled={disabled}
        popoverTarget={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          const rect = trigger.current!.getBoundingClientRect();
          setPosition({
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
            bottom: window.innerHeight - rect.top + 4,
            maxHeight: Math.max(
              0,
              Math.min(window.innerHeight * 0.6, rect.top - 12),
            ),
          });
        }}
        className="inline-flex max-w-44 items-center gap-1 rounded-full px-2 py-1 text-meta text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:text-neutral-600"
      >
        <span className="fade-end min-w-0 overflow-hidden whitespace-nowrap">
          {label}
        </span>
        <CaretDown size={12} className="shrink-0" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={`Choose ${what} or startup default`}
        onToggle={(event) => {
          const next = event.newState === "open";
          setOpen(next);
          if (next) {
            const selected = popup.current?.querySelector<HTMLButtonElement>(
              '[data-current="true"]',
            );
            selected?.focus({ preventScroll: true });
            selected?.scrollIntoView({ block: "nearest" });
          }
        }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button[data-choice]",
            ),
          ];
          if (!buttons.length) return;
          event.preventDefault();
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (current +
                    (event.key === "ArrowUp" ? -1 : 1) +
                    buttons.length) %
                  buttons.length;
          buttons[index]?.focus();
        }}
        style={{
          left: position.left,
          bottom: position.bottom,
          top: "auto",
          width: "min(20rem, calc(100vw - 1rem))",
        }}
        className="m-0 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 p-1 text-neutral-200 shadow-xl"
      >
        <ScrollPane
          style={{ maxHeight: position.maxHeight }}
          innerClassName="py-1"
        >
          {groups.map((group, index) => (
            <div key={group.label ?? index}>
              {group.label && (
                <div className="px-2 py-1 text-caption uppercase tracking-wide text-neutral-500">
                  {group.label}
                </div>
              )}
              {group.options.map((option) => (
                <div
                  key={option.value}
                  className="flex items-center rounded-sm hover:bg-neutral-800 focus-within:bg-neutral-800"
                >
                  <DefaultStar
                    what={what}
                    saved={saved === option.value}
                    onToggle={() => onDefault(option.value)}
                  />
                  <button
                    data-custom="composer popup option"
                    type="button"
                    data-choice=""
                    data-current={value === option.value}
                    aria-current={value === option.value ? "true" : undefined}
                    className={`min-w-0 flex-1 rounded-sm px-2 py-1 text-left text-ui focus-visible:outline focus-visible:outline-amber-400 ${value === option.value ? "text-amber-400" : "text-neutral-200"}`}
                    onClick={() => {
                      onChange(option.value);
                      popup.current?.hidePopover();
                      trigger.current?.focus();
                    }}
                  >
                    <span className="fade-end block overflow-hidden whitespace-nowrap">
                      {option.label}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          ))}
        </ScrollPane>
      </div>
    </>
  );
}
