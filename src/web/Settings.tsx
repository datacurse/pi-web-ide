import { useEffect, useState } from "react";
import { Button, inputClass, OptionRow, PanelHeader, Section } from "./ui.js";
import { THEMES, TOOL_MODES, type ThemeId, type ToolMode } from "./prefs.js";

/** What GET/PUT /api/personality answer with. */
interface Personality {
	path: string;
	content: string;
	exists: boolean;
	remind: boolean;
}

type SaveState = "idle" | "saving" | "saved";

/** The subset of /api/usage (Anthropic's oauth/usage) this dialog reads. */
interface UsageLimit {
	kind: string;
	percent: number;
	resets_at: string | null;
	scope: { model?: { display_name?: string | null } } | null;
}

function limitLabel(l: UsageLimit): string {
	if (l.kind === "session") return "Current session";
	if (l.kind === "weekly_all") return "This week";
	const model = l.scope?.model?.display_name;
	return model ? `${model} this week` : l.kind.replace(/_/g, " ");
}

function resetLabel(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return d.getTime() - Date.now() < 86_400_000
		? `Resets at ${time}`
		: `Resets ${d.toLocaleDateString([], { weekday: "long" })} ${time}`;
}

/**
 * Four squares of a palette's actual colors: backdrop, border, body text,
 * accent.
 *
 * The colors come from the SAME `data-theme` mechanism that paints the app,
 * so a preview cannot drift from what selecting it will look like, and no hex
 * value is duplicated outside index.css. The frame is deliberately outside
 * the themed subtree so it stays in the palette currently in use.
 */
function Swatch({ theme }: { theme: ThemeId }) {
	return (
		<span
			aria-hidden
			className="flex shrink-0 overflow-hidden rounded-sm border border-neutral-700"
		>
			<span data-theme={theme} className="flex">
				<span className="block size-4 bg-neutral-950" />
				<span className="block size-4 bg-neutral-800" />
				<span className="block size-4 bg-neutral-100" />
				<span className="block size-4 bg-amber-400" />
			</span>
		</span>
	);
}

/**
 * The Settings page, shown in a tab: one <fieldset> per setting, all but the
 * personality browser-local (see prefs.ts).
 *
 * Stays mounted while its tab is open, so an unsaved personality edit
 * survives switching tabs. `open` is "the tab is showing".
 */
export function Settings({
	open,
	theme,
	onTheme,
	showThinking,
	onShowThinking,
	toolMode,
	onToolMode,
	notify,
	onNotify,
	shortNames,
	onShortNames,
	onClose,
}: {
	open: boolean;
	theme: ThemeId;
	onTheme: (theme: ThemeId) => void;
	showThinking: boolean;
	onShowThinking: (show: boolean) => void;
	toolMode: ToolMode;
	onToolMode: (mode: ToolMode) => void;
	notify: boolean;
	onNotify: (on: boolean) => void;
	shortNames: boolean;
	onShortNames: (on: boolean) => void;
	onClose: () => void;
}) {
	/*
	 * Permission is read at render rather than stored: the browser owns it,
	 * it can be revoked from the address bar at any time, and a copy in React
	 * state would be the stale one. Both branches disable the control, for
	 * different reasons the hint has to tell apart — "your browser cannot"
	 * and "you told your browser not to" are not the same answer.
	 */
	const supported = typeof Notification !== "undefined";
	const notifyBlocked = !supported || Notification.permission === "denied";
	const notifyHint = !supported
		? "This browser does not support notifications."
		: Notification.permission === "denied"
			? "Blocked — allow notifications for this site in your browser."
			: "Only when the page is in the background. Shows the first line of the answer.";

	/*
	 * Personality lives on the server, so unlike every other control here it
	 * has to be fetched — and it is fetched by this component rather than
	 * lifted into App, because nothing outside the dialog reads it and a piece
	 * of state whose only consumer is one panel does not belong three levels up.
	 *
	 * Reloaded on every open so an edit made in $EDITOR (or on another machine's
	 * pwi) is what you see — EXCEPT when there are unsaved edits, which a
	 * refetch would silently throw away. Closing the dialog by accident is one
	 * Escape press; losing the paragraph you just typed to it would be pwi's
	 * fault, not yours.
	 */
	const [personality, setPersonality] = useState<Personality | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [saveError, setSaveError] = useState<string | null>(null);
	const dirty = draft !== null && draft !== personality?.content;

	const [loadError, setLoadError] = useState<string | null>(null);

	const [limits, setLimits] = useState<UsageLimit[] | null>(null);
	const [usageError, setUsageError] = useState<string | null>(null);
	useEffect(() => {
		if (!open) return;
		void (async () => {
			const r = await fetch("/api/usage").catch(() => null);
			const body = (await r?.json().catch(() => null)) as {
				limits?: UsageLimit[];
				error?: string;
			} | null;
			if (r?.ok && Array.isArray(body?.limits)) {
				setLimits(body.limits);
				setUsageError(null);
			} else setUsageError(body?.error ?? "could not load usage");
		})();
	}, [open]);

	useEffect(() => {
		if (!open || dirty) return;
		void (async () => {
			// The personality on screen is the selected host's, not this page's.
			const r = await fetch(`/api/personality`).catch(() => null);
			/*
			 * Every failure mode ends up as a message, never as a control that
			 * sits on "loading…" forever. The one that actually happened: a
			 * browser running this code against a pwi process started before the
			 * endpoint existed, where the SPA fallback answered with index.html
			 * and a 200 — so a successful-looking response whose body is not JSON
			 * has to be treated as the version mismatch it is.
			 */
			const loaded = r?.ok
				? ((await r.json().catch(() => null)) as Personality | null)
				: null;
			if (!loaded || typeof loaded.content !== "string") {
				setLoadError(
					r && !r.ok
						? `could not read it (HTTP ${r.status})`
						: "could not read it — is this pwi older than the field? restart it",
				);
				return;
			}
			setPersonality(loaded);
			setDraft(loaded.content);
			setSaveState("idle");
			setSaveError(null);
			setLoadError(null);
		})();
		// `dirty` is deliberately not a dependency: this runs on open, and
		// re-running it the moment an edit is undone would refetch mid-typing.
	}, [open]);

	// Saved on click like every other checkbox here, independent of the text's
	// Save button, since it is its own file on the server.
	const saveRemind = async (remind: boolean) => {
		const r = await fetch(`/api/personality/remind`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ remind }),
		}).catch(() => null);
		if (!r?.ok) {
			setSaveError("could not save the reminder setting");
			return;
		}
		setPersonality((p) => (p ? { ...p, remind } : p));
	};

	const savePersonality = async () => {
		if (draft === null) return;
		setSaveState("saving");
		setSaveError(null);
		const r = await fetch(`/api/personality`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: draft }),
		}).catch(() => null);
		const body = (await r?.json().catch(() => ({}))) as Partial<Personality> & {
			error?: string;
		};
		if (!r?.ok) {
			setSaveState("idle");
			setSaveError(body.error ?? "could not save");
			return;
		}
		// The server answers with what it wrote (a trailing newline may have
		// been added), so the draft is reconciled against the file rather than
		// against what was typed — otherwise the field stays "dirty" forever.
		const saved: Personality = {
			path: body.path ?? personality?.path ?? "",
			content: body.content ?? draft,
			exists: true,
			remind: body.remind ?? personality?.remind ?? false,
		};
		setPersonality(saved);
		setDraft(saved.content);
		setSaveState("saved");
	};

	return (
		<section
			aria-label="Settings"
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
		>
			<PanelHeader title="Settings" onClose={onClose} />
			<div className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto w-full max-w-xl p-3">
				<Section title="Usage remaining" className="mb-4">
					{usageError ? (
						<p className="px-2 text-meta text-red-400">{usageError}</p>
					) : !limits ? (
						<p className="px-2 text-meta text-neutral-500">loading…</p>
					) : (
						<div className="flex flex-col gap-3 px-2">
							{limits.map((l) => {
								const left = Math.max(0, Math.min(100, 100 - l.percent));
								return (
									<div key={`${l.kind}-${limitLabel(l)}`} className="text-ui">
										<div className="flex items-baseline justify-between gap-2">
											<span>{limitLabel(l)}</span>
											<span className="text-meta text-neutral-300">{left}% left</span>
										</div>
										<div
											role="meter"
											aria-label={`${limitLabel(l)} remaining`}
											aria-valuenow={left}
											aria-valuemin={0}
											aria-valuemax={100}
											className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-800"
										>
											<div
												className="h-full rounded-full bg-green-400"
												style={{ width: `${left}%` }}
											/>
										</div>
										<span className="mt-0.5 block text-meta text-neutral-500">
											{resetLabel(l.resets_at)}
										</span>
									</div>
								);
							})}
						</div>
					)}
				</Section>

				{/*
				  Real radios, visually hidden: the group gets arrow-key
				  navigation, roving focus and the right screen reader
				  announcement without a line of JavaScript.
				*/}
				<Section title="Theme">
					<div className="flex flex-col gap-0.5">
						{THEMES.map((t) => (
							<OptionRow key={t.id} selected={t.id === theme}>
								<input
									type="radio"
									name="theme"
									value={t.id}
									checked={t.id === theme}
									onChange={() => onTheme(t.id)}
									className="sr-only"
								/>
								<Swatch theme={t.id} />
								<span className="flex-1">{t.label}</span>
								<span
									aria-hidden
									className={t.id === theme ? "text-amber-400" : "invisible"}
								>
									{"\u2713"}
								</span>
							</OptionRow>
						))}
					</div>
				</Section>

				<Section title="Transcript" className="mt-4">
					{/* A real checkbox, visible rather than sr-only: unlike the
					    theme rows there is no swatch to carry the state, so the
					    box itself is the affordance. */}
					<OptionRow>
						<input
							type="checkbox"
							checked={showThinking}
							onChange={(e) => onShowThinking(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Show thinking
							<span className="block text-meta text-neutral-500">
								Reasoning blocks in assistant messages, as they stream and in history.
							</span>
						</span>
					</OptionRow>

					{/* Radios, not a second checkbox: "collapsed" and "hidden" are
					    different answers to one question, and a group of two
					    checkboxes would let you tick both. */}
					<div role="group" aria-labelledby="tool-mode-label" className="mt-2">
						<div id="tool-mode-label" className="px-2 pt-1 pb-1 text-ui text-neutral-300">
							Tool calls
						</div>
						{TOOL_MODES.map((m) => (
							<OptionRow key={m.id} selected={m.id === toolMode}>
								<input
									type="radio"
									name="toolMode"
									value={m.id}
									checked={m.id === toolMode}
									onChange={() => onToolMode(m.id)}
									className="size-3.5 shrink-0 accent-amber-400"
								/>
								<span className="flex-1">
									{m.label}
									<span className="block text-meta text-neutral-500">{m.hint}</span>
								</span>
							</OptionRow>
						))}
					</div>
				</Section>

				<Section title="Sessions" className="mt-4">
					<OptionRow>
						<input
							type="checkbox"
							checked={shortNames}
							onChange={(e) => onShortNames(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Short names from the first prompt
							<span className="block text-meta text-neutral-500">
								Names an unnamed session by the opening words of your first message
								instead of showing the whole line. A name you set with the pencil in the
								session list always wins.
							</span>
						</span>
					</OptionRow>
				</Section>

				<Section title="Notifications" className="mt-4">
					<OptionRow disabled={notifyBlocked}>
						<input
							type="checkbox"
							checked={notify}
							disabled={notifyBlocked}
							onChange={(e) => onNotify(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Notify when a run finishes
							<span className="block text-meta text-neutral-500">{notifyHint}</span>
						</span>
					</OptionRow>
				</Section>

				{/*
				  The one control here that is not browser-local: it edits this
				  server's own personality.md, in the state directory. The path is
				  shown because a field that silently writes a file somewhere is
				  worse than no field, and the hint says when the change lands —
				  the file is handed to each child as `--append-system-prompt` at
				  spawn, so a running session keeps the prompt it started with.
				*/}
				<Section title="Personality" className="mt-4">
					<label className="block px-2">
						<span className="text-ui text-neutral-300">
							Appended to every new session's system prompt
						</span>
						<span className="mt-0.5 block font-mono text-meta break-all text-neutral-500">
							{loadError ? (
								<span className="text-red-400">{loadError}</span>
							) : (
								<>
									{personality?.path ?? "loading…"}
									{personality && !personality.exists && " (not created yet)"}
								</>
							)}
						</span>
						<textarea
							value={draft ?? ""}
							onChange={(e) => {
								setDraft(e.target.value);
								setSaveState("idle");
							}}
							disabled={draft === null}
							rows={10}
							spellCheck={false}
							placeholder={
								loadError
									? "Unavailable."
									: "Empty means nothing is appended."
							}
							className={`mt-2 block w-full resize-y font-mono ${inputClass.sm}`}
						/>
					</label>
					<div className="mt-2 flex items-center gap-2 px-2">
						<Button
							variant="subtle"
							size="sm"
							onClick={() => void savePersonality()}
							disabled={!dirty || saveState === "saving"}
						>
							{saveState === "saving" ? "Saving…" : "Save"}
						</Button>
						<span className="min-w-0 flex-1 text-meta text-neutral-500">
							{saveError ? (
								<span className="text-red-400">{saveError}</span>
							) : dirty ? (
								"Unsaved changes."
							) : saveState === "saved" ? (
								"Saved. Applies to sessions started from now on."
							) : (
								"Read from disk each time Settings is shown."
							)}
						</span>
					</div>
					<OptionRow className="mt-2">
						<input
							type="checkbox"
							checked={personality?.remind ?? false}
							disabled={!personality}
							onChange={(e) => void saveRemind(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Repeat before every reply
							<span className="block text-meta text-neutral-500">
								Also adds the text to the end of each of your messages on every model
								request, so long sessions do not drift from it. Costs its length in
								tokens per message, mostly at the cache-read rate. Applies to sessions
								started from now on.
							</span>
						</span>
					</OptionRow>
				</Section>
			</div>
			</div>
		</section>
	);
}
