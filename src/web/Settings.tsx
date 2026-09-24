import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { THEMES, TOOL_MODES, type ThemeId, type ToolMode } from "./prefs.js";

/** What GET/PUT /api/personality answer with. */
interface Personality {
	path: string;
	content: string;
	exists: boolean;
	remind: boolean;
}

type SaveState = "idle" | "saving" | "saved";

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
			className="flex shrink-0 overflow-hidden rounded border border-neutral-700"
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
 * The settings dialog: one <fieldset> per setting, all of them
 * browser-local (see prefs.ts).
 *
 * A native <dialog> opened with showModal() rather than a hand-rolled
 * overlay: it brings the focus trap, the Escape binding, inertness of the
 * page behind it and the top layer (so no z-index has to be reasoned about
 * against the session drawer) for free, and all four are things a div gets
 * wrong quietly.
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

	const ref = useRef<HTMLDialogElement>(null);

	// showModal() is imperative — the `open` ATTRIBUTE renders a non-modal
	// dialog, which is a different (and here, wrong) thing.
	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	}, [open]);

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
		<dialog
			ref={ref}
			aria-labelledby="settings-title"
			// Escape and the close button both end up here, so React state and
			// the element's own open state cannot disagree.
			onClose={onClose}
			// Clicking the backdrop targets the dialog itself; a click anywhere
			// on its contents targets a descendant.
			onClick={(e) => {
				if (e.target === ref.current) onClose();
			}}
			// max-h + overflow because the dialog outgrew the viewport once the
			// personality field arrived: a <dialog> does not scroll by default,
			// so the Save button simply had nowhere to be on a short screen.
			className="m-auto max-h-[88vh] w-[min(26rem,92vw)] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/60"
		>
			<div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
				<h2 id="settings-title" className="text-sm font-semibold tracking-tight">
					Settings
				</h2>
				<button
					onClick={onClose}
					aria-label="Close settings"
					className="size-8 rounded text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
				>
					<X size={13} />
				</button>
			</div>

			<div className="p-3">
				{/*
				  Real radios, visually hidden: the group gets arrow-key
				  navigation, roving focus and the right screen reader
				  announcement without a line of JavaScript.
				*/}
				<fieldset className="m-0 border-0 p-0">
					<legend className="mb-2 text-[10px] tracking-wide text-neutral-500 uppercase">
						Theme
					</legend>
					<div className="flex flex-col gap-0.5">
						{THEMES.map((t) => (
							<label
								key={t.id}
								className={`flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm transition-colors duration-150 ease-out has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-neutral-400 motion-reduce:transition-none ${
									t.id === theme ? "bg-neutral-800" : "hover:bg-neutral-900"
								}`}
							>
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
							</label>
						))}
					</div>
				</fieldset>

				<fieldset className="m-0 mt-4 border-0 p-0">
					<legend className="mb-2 text-[10px] tracking-wide text-neutral-500 uppercase">
						Transcript
					</legend>
					{/* A real checkbox, visible rather than sr-only: unlike the
					    theme rows there is no swatch to carry the state, so the
					    box itself is the affordance. */}
					<label className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm transition-colors duration-150 ease-out hover:bg-neutral-900 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-neutral-400 motion-reduce:transition-none">
						<input
							type="checkbox"
							checked={showThinking}
							onChange={(e) => onShowThinking(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Show thinking
							<span className="block text-xs text-neutral-500">
								Reasoning blocks in assistant messages, as they stream and in history.
							</span>
						</span>
					</label>

					{/* Radios, not a second checkbox: "collapsed" and "hidden" are
					    different answers to one question, and a group of two
					    checkboxes would let you tick both. */}
					<div role="group" aria-labelledby="tool-mode-label" className="mt-2">
						<div id="tool-mode-label" className="px-2 pt-1 pb-1 text-sm text-neutral-300">
							Tool calls
						</div>
						{TOOL_MODES.map((m) => (
							<label
								key={m.id}
								className={`flex cursor-pointer items-start gap-3 rounded px-2 py-1.5 text-sm transition-colors duration-150 ease-out has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-neutral-400 motion-reduce:transition-none ${
									m.id === toolMode ? "bg-neutral-800" : "hover:bg-neutral-900"
								}`}
							>
								<input
									type="radio"
									name="toolMode"
									value={m.id}
									checked={m.id === toolMode}
									onChange={() => onToolMode(m.id)}
									className="mt-1 size-3.5 shrink-0 accent-amber-400"
								/>
								<span className="flex-1">
									{m.label}
									<span className="block text-xs text-neutral-500">{m.hint}</span>
								</span>
							</label>
						))}
					</div>
				</fieldset>

				<fieldset className="m-0 mt-4 border-0 p-0">
					<legend className="mb-2 text-[10px] tracking-wide text-neutral-500 uppercase">
						Sessions
					</legend>
					<label className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm transition-colors duration-150 ease-out hover:bg-neutral-900 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-neutral-400 motion-reduce:transition-none">
						<input
							type="checkbox"
							checked={shortNames}
							onChange={(e) => onShortNames(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Short names from the first prompt
							<span className="block text-xs text-neutral-500">
								Names an unnamed session by the opening words of your first message
								instead of showing the whole line. A name you set with the pencil in the
								session list always wins.
							</span>
						</span>
					</label>
				</fieldset>

				<fieldset className="m-0 mt-4 border-0 p-0">
					<legend className="mb-2 text-[10px] tracking-wide text-neutral-500 uppercase">
						Notifications
					</legend>
					<label
						className={`flex items-center gap-3 rounded px-2 py-2 text-sm transition-colors duration-150 ease-out has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-neutral-400 motion-reduce:transition-none ${
							notifyBlocked ? "opacity-60" : "cursor-pointer hover:bg-neutral-900"
						}`}
					>
						<input
							type="checkbox"
							checked={notify}
							disabled={notifyBlocked}
							onChange={(e) => onNotify(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Notify when a run finishes
							<span className="block text-xs text-neutral-500">{notifyHint}</span>
						</span>
					</label>
				</fieldset>

				{/*
				  The one control here that is not browser-local: it edits this
				  server's own personality.md, in the state directory. The path is
				  shown because a field that silently writes a file somewhere is
				  worse than no field, and the hint says when the change lands —
				  the file is handed to each child as `--append-system-prompt` at
				  spawn, so a running session keeps the prompt it started with.
				*/}
				<fieldset className="m-0 mt-4 border-0 p-0">
					<legend className="mb-2 text-[10px] tracking-wide text-neutral-500 uppercase">
						Personality
					</legend>
					<label className="block px-2">
						<span className="text-sm text-neutral-300">
							Appended to every new session's system prompt
						</span>
						<span className="mt-0.5 block font-mono text-[10px] break-all text-neutral-500">
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
							className="mt-2 block w-full resize-y rounded border border-neutral-800 bg-neutral-900 p-2 font-mono text-xs text-neutral-200 outline-none focus-visible:border-neutral-600"
						/>
					</label>
					<div className="mt-2 flex items-center gap-2 px-2">
						<button
							onClick={() => void savePersonality()}
							disabled={!dirty || saveState === "saving"}
							className="rounded bg-neutral-800 px-2 py-1 text-xs transition-colors duration-150 ease-out hover:bg-neutral-700 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 disabled:opacity-50 disabled:hover:bg-neutral-800 motion-reduce:transition-none"
						>
							{saveState === "saving" ? "Saving…" : "Save"}
						</button>
						<span className="min-w-0 flex-1 text-[10px] text-neutral-500">
							{saveError ? (
								<span className="text-red-400">{saveError}</span>
							) : dirty ? (
								"Unsaved changes."
							) : saveState === "saved" ? (
								"Saved. Applies to sessions started from now on."
							) : (
								"Read from disk each time this dialog opens."
							)}
						</span>
					</div>
					<label className="mt-2 flex cursor-pointer items-center gap-3 rounded px-2 py-2 text-sm transition-colors duration-150 ease-out hover:bg-neutral-900 has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-neutral-400 motion-reduce:transition-none">
						<input
							type="checkbox"
							checked={personality?.remind ?? false}
							disabled={!personality}
							onChange={(e) => void saveRemind(e.target.checked)}
							className="size-4 shrink-0 accent-amber-400"
						/>
						<span className="flex-1">
							Repeat before every reply
							<span className="block text-xs text-neutral-500">
								Also adds the text to the end of your latest message on each model
								request, so long sessions do not drift from it. Costs its length in
								tokens per request. Applies to sessions started from now on.
							</span>
						</span>
					</label>
				</fieldset>
			</div>
		</dialog>
	);
}
