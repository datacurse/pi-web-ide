import { useEffect, useMemo, useState } from "react";
import { Star } from "@phosphor-icons/react";

/**
 * Header controls for the active session's model: one select for the
 * provider, one for that provider's models, one for reasoning effort.
 *
 * All native <select>. A custom dropdown bought us a filter box and cost
 * click-outside handling, escape handling, and a scroll container; splitting
 * provider from model shortens each list enough that the filter stopped
 * earning its keep.
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
	origin,
	disabled,
	error,
	onChange,
	thinkingLevel,
	thinkingLevels,
	onThinkingChange,
}: {
	model: string | undefined;
	/** Where this project's piw answers: "" for this page's own server, else a machine's origin with no trailing slash. */
	origin: string;
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
	const [provider, setProvider] = useState(model?.split("/")[0] ?? "");
	const [savedDefault, setSavedDefault] = useState(false);

	useEffect(() => {
		let cancelled = false;
		fetch(`${origin}/api/models`)
			.then((r) => r.json())
			.then((d) => {
				if (!cancelled) setModels(d.models ?? []);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [origin]);

	// Follow the session: a model set elsewhere (resume, another tab) must move
	// the provider select with it, or the two boxes disagree about reality.
	useEffect(() => {
		if (model) setProvider(model.split("/")[0]);
	}, [model]);

	const providers = useMemo(() => [...new Set(models.map((m) => m.split("/")[0]))].sort(), [models]);
	const forProvider = useMemo(() => models.filter((m) => m.startsWith(`${provider}/`)), [models, provider]);

	// Reset the "saved" confirmation whenever the selection moves on — it marks
	// that THIS model was just saved, not a permanent state of the button.
	useEffect(() => setSavedDefault(false), [model]);

	const saveAsDefault = async () => {
		if (!model) return;
		const r = await fetch(`${origin}/api/default-model`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model }),
		});
		if (r.ok) setSavedDefault(true);
	};

	// Pills, not boxed inputs: these now live INSIDE the composer, where a
	// bordered field inside a bordered field is two edges for one control.
	const cls = `rounded-full bg-transparent px-2 py-1 font-mono text-xs ${
		disabled ? "cursor-not-allowed text-neutral-600" : "text-neutral-300 hover:bg-neutral-800"
	}`;
	const title = disabled ? "Cannot switch models while streaming" : "Switch model";

	return (
		<div className="relative flex items-center gap-1">
			<select
				value={provider}
				disabled={disabled}
				title={title}
				// Switching provider commits its first model immediately: leaving the
				// pair in a state where the provider box disagrees with the session is
				// worse than picking a default the user can then change.
				onChange={(e) => {
					const p = e.target.value;
					setProvider(p);
					const first = models.find((m) => m.startsWith(`${p}/`));
					if (first && first !== model) onChange(first);
				}}
				className={cls}
			>
				{providers.length === 0 && <option value="">(no providers)</option>}
				{providers.map((p) => (
					<option key={p} value={p}>
						{p}
					</option>
				))}
			</select>

			<select
				value={model ?? ""}
				disabled={disabled || forProvider.length === 0}
				title={title}
				onChange={(e) => onChange(e.target.value)}
				// Capped: the model list holds names like
				// `claude-sonnet-4-5-20250929`, and a select sized to its widest
				// option pushed the send button off the composer row.
				className={`${cls} max-w-44 truncate`}
			>
				{!model && <option value="">(no model)</option>}
				{forProvider.map((m) => (
					<option key={m} value={m}>
						{m.slice(provider.length + 1)}
					</option>
				))}
			</select>

			{thinkingLevels.length > 0 && (
				<select
					value={thinkingLevel ?? ""}
					title="Reasoning effort — applies from the next turn"
					onChange={(e) => onThinkingChange(e.target.value)}
					className="rounded-full bg-transparent px-2 py-1 font-mono text-xs text-neutral-300 hover:bg-neutral-800"
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

			<button
				type="button"
				disabled={!model || savedDefault}
				onClick={saveAsDefault}
				title={savedDefault ? "Saved as startup default" : "Save this model as the startup default"}
				className={`flex size-7 items-center justify-center rounded-full border border-neutral-800 ${
					savedDefault
						? "text-yellow-500"
						: "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
				}`}
			>
				<Star size={13} weight={savedDefault ? "fill" : "regular"} />
			</button>

			{error && (
				<div className="absolute right-0 top-full mt-1 w-80 rounded border border-red-900 bg-red-950/80 px-2 py-1 text-xs text-red-300">
					{error}
				</div>
			)}
		</div>
	);
}
