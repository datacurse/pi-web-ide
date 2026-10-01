import { type SyntheticEvent, useEffect, useMemo, useState } from "react";
import { Star } from "@phosphor-icons/react";
import { Button } from "./ui.js";
import { api } from "./api.js";
import { t } from "./i18n.js";

/**
 * Composer controls for the active session's model: one select for the model
 * (grouped by provider), one for reasoning effort.
 *
 * All native <select>. A custom dropdown bought us a filter box and cost
 * click-outside handling, escape handling, and a scroll container; provider
 * `<optgroup>`s keep the one list scannable without it. `field-sizing: content`
 * sizes each select to its CURRENT option rather than its widest one, which
 * left a gap before the chevron; browsers without it fall back to `max-w-44`.
 *
 * Models are fetched once per mount and cached — the available set only
 * changes when auth changes, which happens outside this app. Switching is
 * disabled while streaming (see registry.setModel for why) and shown as a
 * disabled control rather than hidden, so it is clear the feature exists but
 * is momentarily unavailable. The thinking select is NOT disabled: it takes
 * effect on the next turn, so there is nothing in flight for it to disturb.
 */
export function ModelSelector({
	model,
	disabled,
	error,
	onChange,
	thinkingLevel,
	thinkingLevels,
	onThinkingChange,
}: {
	model: string | undefined;
	disabled: boolean;
	/** Surfaced from the last failed switch attempt, if any. */
	error?: string | null;
	onChange: (model: string) => void;
	/** Empty when the model has no reasoning levels; the control then hides. */
	thinkingLevel: string | undefined;
	thinkingLevels: string[];
	onThinkingChange: (level: string) => void;
}) {
	const [models, setModels] = useState<string[]>([]);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [attempt, setAttempt] = useState(0);
	/** pi's saved startup model, so the star shows the truth after a reload or a switch. */
	const [defaultModel, setDefaultModel] = useState<string | null>(null);
	const [defaultThinking, setDefaultThinking] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const controller = new AbortController();
		const timeout = window.setTimeout(() => controller.abort(), 15_000);
		setLoading(true);
		setCatalogError(null);
		void (async () => {
			try {
				const r = await api.models.$get({}, { init: { signal: controller.signal } });
				const d = await r.json();
				if (!r.ok || "error" in d) {
					throw new Error("error" in d ? d.error : String(r.status));
				}
				if (cancelled) return;
				if (!d.models?.length) throw new Error(t("No authenticated models available"));
				setModels(d.models);
				setDefaultModel(d.default ?? null);
				setDefaultThinking(d.defaultThinking ?? null);
			} catch (err) {
				if (!cancelled) setCatalogError(controller.signal.aborted
					? t("Model list timed out. Close other app browser tabs and retry.")
					: t("Could not load models: {error}", { error: err instanceof Error ? err.message : String(err) }));
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

	const providers = useMemo(() => [...new Set(models.map((m) => m.split("/")[0]))].sort(), [models]);

	/** Star toggles: save the current value as pi's startup default, or clear it if it already is. */
	const toggleDefault = async (
		save: (next: string | null) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>,
		current: string | null,
		value: string,
		set: (v: string | null) => void,
	) => {
		const next = current === value ? null : value;
		const r = await save(next);
		if (r.ok) set(next);
		else
			alert(
				t("Could not save default: {error}", {
					error: ((await r.json().catch(() => ({}))) as { error?: string }).error ?? r.status,
				}),
			);
	};

	// Pills, not boxed inputs: these live INSIDE the composer, where a
	// bordered field inside a bordered field is two edges for one control.
	// Sans, like the rest of the composer.
	const cls = "pill-select field-sizing-content max-w-44 truncate rounded-full bg-transparent px-2 py-1 text-meta";
	const tone = disabled ? "cursor-not-allowed text-neutral-600" : "text-neutral-300 hover:bg-neutral-800";

	return (
		<div className="relative flex items-center gap-0.5">
			<select
				data-custom="composer pill"
				value={model ?? ""}
				disabled={disabled || models.length === 0}
				title={disabled ? t("Cannot switch models while streaming") : loading ? t("Loading models…") : (catalogError ?? model ?? t("Switch model"))}
				onChange={(e) => onChange(e.target.value)}
				className={`${cls} ${tone}`}
			>
				{/* The session's model may be missing from the list (not fetched
				    yet, or auth changed); show it rather than a wrong one. */}
				{(!model || !models.includes(model)) && <option value={model ?? ""}>{model?.split("/").pop() ?? t("(no model)")}</option>}
				{providers.map((p) => (
					<optgroup key={p} label={p}>
						{models
							.filter((m) => m.startsWith(`${p}/`))
							.map((m) => (
								<option key={m} value={m}>
									<DefaultStar
										what="model"
										saved={m === defaultModel}
										onToggle={() => toggleDefault((model) => api["default-model"].$post({ json: { model } }), defaultModel, m, setDefaultModel)}
									/>
									{m.slice(p.length + 1)}
								</option>
							))}
					</optgroup>
				))}
			</select>

			{thinkingLevels.length > 0 && (
				<select
					data-custom="composer pill"
					value={thinkingLevel ?? ""}
					title={t("Reasoning effort — applies from the next turn")}
					onChange={(e) => onThinkingChange(e.target.value)}
					className={`${cls} text-neutral-300 hover:bg-neutral-800`}
				>
					{/* pi can report a level outside the model's own list (a
					    session resumed under a different model). Show it rather
					    than silently displaying the wrong one. */}
					{thinkingLevel !== undefined && !thinkingLevels.includes(thinkingLevel) && (
						<option value={thinkingLevel}>{thinkingLevel}</option>
					)}
					{thinkingLevels.map((l) => (
						<option key={l} value={l}>
							<DefaultStar
								what="reasoning level"
								saved={l === defaultThinking}
								onToggle={() => toggleDefault((level) => api["default-thinking"].$post({ json: { level } }), defaultThinking, l, setDefaultThinking)}
							/>
							{l}
						</option>
					))}
				</select>
			)}

			{catalogError && (
				<Button size="sm" variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
					{t("Retry")}
				</Button>
			)}
			{(error || catalogError) && (
				<div role="alert" className="absolute bottom-full right-0 mb-1 w-80 rounded-sm border border-red-900 bg-red-950/80 px-2 py-1 text-meta text-red-300">
					{error || catalogError}
				</div>
			)}
		</div>
	);
}

/**
 * A star inside a pill's popup option: saves or clears that option as pi's
 * startup default. It must not also pick the option, and Chromium's
 * customizable select skips its option handling for a prevented event.
 * Cancelling pointerdown suppresses the mousedown/mouseup that would select;
 * the click is cancelled where it is handled. Other browsers render options
 * as plain text, so there the star simply does not appear.
 */
function DefaultStar({
	what,
	saved,
	onToggle,
}: {
	what: "model" | "reasoning level";
	saved: boolean;
	onToggle: () => void;
}) {
	const stop = (e: SyntheticEvent) => {
		e.preventDefault();
		e.stopPropagation();
	};
	return (
		<span
			title={
				what === "model"
					? saved
						? t("Startup default model \u2014 click to clear")
						: t("Make this the startup default model")
					: saved
						? t("Startup default reasoning level \u2014 click to clear")
						: t("Make this the startup default reasoning level")
			}
			onPointerDown={stop}
			onPointerUp={stop}
			onClick={(e) => {
				stop(e);
				onToggle();
			}}
			className={`mr-2 inline-flex align-middle ${saved ? "text-amber-400" : "text-neutral-600 hover:text-neutral-300"}`}
		>
			<Star size={13} weight={saved ? "fill" : "regular"} />
		</span>
	);
}
