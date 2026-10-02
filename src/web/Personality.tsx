/**
 * Personality.tsx — the text pwi appends to every new session's system
 * prompt, and the reminder that repeats it (remind-extension.ts). Shown with
 * the pwi extensions in Packages.
 *
 * The one control there that edits a file: this server's own personality.md,
 * in the state directory. The path is shown because a field that silently
 * writes a file somewhere is worse than no field, and the hint says when the
 * change lands — the file is handed to each child as `--append-system-prompt`
 * at spawn, so a running session keeps the prompt it started with.
 */

import { useEffect, useState } from "react";
import { Button, inputClass, OptionRow } from "./ui.js";
import { api } from "./api.js";
import { t } from "./i18n.js";

/** What GET/PUT /api/personality answer with. */
interface PersonalityFile {
	path: string;
	content: string;
	exists: boolean;
	remind: boolean;
	enabled: boolean;
}

type SaveState = "idle" | "saving" | "saved";

export function Personality({ open }: { open: boolean }) {
	/*
	 * Reloaded on every open so an edit made in $EDITOR (or on another machine's
	 * pwi) is what you see — EXCEPT when there are unsaved edits, which a
	 * refetch would silently throw away. Closing the dialog by accident is one
	 * Escape press; losing the paragraph you just typed to it would be pwi's
	 * fault, not yours.
	 */
	const [personality, setPersonality] = useState<PersonalityFile | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const dirty = draft !== null && draft !== personality?.content;

	useEffect(() => {
		if (!open || dirty) return;
		void (async () => {
			const r = await api.personality.$get().catch(() => null);
			/*
			 * Every failure mode ends up as a message, never as a control that
			 * sits on "loading…" forever. The one that actually happened: a
			 * browser running this code against a pwi process started before the
			 * endpoint existed, where the SPA fallback answered with index.html
			 * and a 200 — so a successful-looking response whose body is not JSON
			 * has to be treated as the version mismatch it is.
			 */
			const loaded = r?.ok ? ((await r.json().catch(() => null)) as PersonalityFile | null) : null;
			if (!loaded || typeof loaded.content !== "string") {
				setLoadError(
					r && !r.ok
						? t("could not read it (HTTP {status})", { status: r.status })
						: t("could not read it — is this pwi older than the field? restart it"),
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

	// Saved on click like every other checkbox, independent of the text's
	// Save button, since it is its own file on the server.
	const saveRemind = async (remind: boolean) => {
		const r = await api.personality.remind.$put({ json: { remind } }).catch(() => null);
		if (!r?.ok) {
			setSaveError(t("could not save the reminder setting"));
			return;
		}
		setPersonality((p) => (p ? { ...p, remind } : p));
	};

	const saveEnabled = async (enabled: boolean) => {
		const r = await api.personality.enabled.$put({ json: { enabled } }).catch(() => null);
		if (!r?.ok) {
			setSaveError(t("could not save the personality setting"));
			return;
		}
		setSaveError(null);
		setPersonality((p) => (p ? { ...p, enabled } : p));
	};

	const save = async () => {
		if (draft === null) return;
		setSaveState("saving");
		setSaveError(null);
		const r = await api.personality.$put({ json: { content: draft } }).catch(() => null);
		const body = (await r?.json().catch(() => ({}))) as Partial<PersonalityFile> & { error?: string };
		if (!r?.ok) {
			setSaveState("idle");
			setSaveError(body.error ?? t("could not save"));
			return;
		}
		// The server answers with what it wrote (a trailing newline may have
		// been added), so the draft is reconciled against the file rather than
		// against what was typed — otherwise the field stays "dirty" forever.
		const saved: PersonalityFile = {
			path: body.path ?? personality?.path ?? "",
			content: body.content ?? draft,
			exists: true,
			remind: body.remind ?? personality?.remind ?? false,
			enabled: body.enabled ?? personality?.enabled ?? true,
		};
		setPersonality(saved);
		setDraft(saved.content);
		setSaveState("saved");
	};

	let status = t("Read from disk each time Packages is shown.");
	if (dirty) status = t("Unsaved changes.");
	else if (saveState === "saved") status = t("Saved. Applies to sessions started from now on.");

	return (
		<div className="mt-4">
			<h4 className="px-2 text-ui text-neutral-200">{t("Personality")}</h4>
			<OptionRow className="mt-2">
				<input
					type="checkbox"
					checked={personality?.enabled ?? true}
					disabled={!personality}
					onChange={(e) => void saveEnabled(e.target.checked)}
					className="size-4 shrink-0 accent-amber-400"
				/>
				<span className="flex-1">
					{t("Enable personality")}
					<span className="block text-meta text-neutral-500">
						{t("When off, no personality text or reminders are sent. Your saved text is kept. Applies to sessions started from now on.")}
					</span>
				</span>
			</OptionRow>
			<label className="mt-1 block px-2">
				<span className="text-meta text-neutral-500">{t("Appended to every new session's system prompt")}</span>
				<span className="mt-0.5 block font-mono text-meta break-all text-neutral-500">
					{loadError ? (
						<span className="text-red-400">{loadError}</span>
					) : (
						<>
							{personality?.path ?? t("loading…")}
							{personality && !personality.exists && ` ${t("(not created yet)")}`}
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
					placeholder={loadError ? t("Unavailable.") : t("Empty means nothing is appended.")}
					className={`mt-2 block w-full resize-y font-mono ${inputClass.sm}`}
				/>
			</label>
			<div className="mt-2 flex items-center gap-2 px-2">
				<Button variant="subtle" size="sm" onClick={() => void save()} disabled={!dirty || saveState === "saving"}>
					{saveState === "saving" ? t("Saving…") : t("Save")}
				</Button>
				<span className="min-w-0 flex-1 text-meta text-neutral-500">
					{saveError ? <span className="text-red-400">{saveError}</span> : status}
				</span>
			</div>
			<OptionRow className="mt-2">
				<input
					type="checkbox"
					checked={personality?.remind ?? false}
					disabled={!personality || !personality.enabled}
					onChange={(e) => void saveRemind(e.target.checked)}
					className="size-4 shrink-0 accent-amber-400"
				/>
				<span className="flex-1">
					{t("Repeat before every reply")}
					<span className="block text-meta text-neutral-500">
						{t(
							"Also adds the text to the end of each of your messages on every model request, so long sessions do not drift from it. Costs its length in tokens per message, mostly at the cache-read rate. Applies to sessions started from now on.",
						)}
					</span>
				</span>
			</OptionRow>
		</div>
	);
}
