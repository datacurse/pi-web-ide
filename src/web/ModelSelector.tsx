import { useEffect, useMemo, useState } from "react";
import { Star } from "@phosphor-icons/react";
import { IconButton } from "./ui.js";

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
	const [savedDefault, setSavedDefault] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetch(`/api/models`)
			.then((r) => r.json())
			.then((d) => {
				if (!cancelled) setModels(d.models ?? []);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const providers = useMemo(() => [...new Set(models.map((m) => m.split("/")[0]))].sort(), [models]);

	// Reset the "saved" confirmation whenever the selection moves on — it marks
	// that THIS model was just saved, not a permanent state of the button.
	useEffect(() => setSavedDefault(false), [model]);

	const saveAsDefault = async () => {
		if (!model) return;
		const r = await fetch(`/api/default-model`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
		});
		if (r.ok) setSavedDefault(true);
	};

	// Pills, not boxed inputs: these live INSIDE the composer, where a
	// bordered field inside a bordered field is two edges for one control.
	// Sans, like the rest of the composer.
	const cls = "field-sizing-content max-w-44 truncate rounded-full bg-transparent px-2 py-1 text-meta";
	const tone = disabled ? "cursor-not-allowed text-neutral-600" : "text-neutral-300 hover:bg-neutral-800";

	return (
		<div className="relative flex items-center gap-0.5">
			<select
				data-custom="composer pill"
				value={model ?? ""}
				disabled={disabled || models.length === 0}
				title={disabled ? "Cannot switch models while streaming" : (model ?? "Switch model")}
				onChange={(e) => onChange(e.target.value)}
				className={`${cls} ${tone}`}
			>
				{/* The session's model may be missing from the list (not fetched
				    yet, or auth changed); show it rather than a wrong one. */}
				{(!model || !models.includes(model)) && <option value={model ?? ""}>{model?.split("/").pop() ?? "(no model)"}</option>}
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

			{thinkingLevels.length > 0 && (
				<select
					data-custom="composer pill"
					value={thinkingLevel ?? ""}
					title="Reasoning effort — applies from the next turn"
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
							{l}
						</option>
					))}
				</select>
			)}

			<IconButton
				size="sm"
				round
				disabled={!model || savedDefault}
				onClick={saveAsDefault}
				label={savedDefault ? "Saved as startup default" : "Save this model as the startup default"}
			>
				<Star
					size={13}
					weight={savedDefault ? "fill" : "regular"}
					className={savedDefault ? "text-amber-400" : undefined}
				/>
			</IconButton>

			{error && (
				<div className="absolute right-0 top-full mt-1 w-80 rounded-sm border border-red-900 bg-red-950/80 px-2 py-1 text-meta text-red-300">
					{error}
				</div>
			)}
		</div>
	);
}
