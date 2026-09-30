/**
 * Packages.tsx — what this machine has installed, and changing it.
 *
 * Two tabs and one table: what is installed here, and the gallery to add
 * from. Every machine runs its own pwi, so "the orangepi is missing pi-lens"
 * is answered by opening the orangepi's pwi, not by this page reaching
 * across — which means no cross-origin requests and no manifest to converge
 * on.
 */

import { Fragment, useCallback, useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { stripAnsi } from "fancy-ansi";
import type {
	PiwMutation,
	PiwPackage,
	PiwPackageInfo,
	PiwPackagesView,
	PiwSearchHit,
	PwiExtensions,
} from "../shared/types.js";
import { Button, IconButton, OptionRow, PanelHeader, inputClass, sectionLabel } from "./ui.js";
import { Personality } from "./Personality.js";
import { Nested, SolPiSettings } from "./SolPiSettings.js";
import { exerciseText, musclesText } from "./Workout.js";
import { WorkoutFigure } from "./workoutFigures.js";
import { EXERCISES, WORKOUT_KINDS, type WorkoutKind, type WorkoutProfile } from "../shared/types.js";
import { setKcal } from "../shared/calories.js";
import { parseResponse } from "hono/client";
import { api } from "./api.js";
import { t, locale, perLocale } from "./i18n.js";

/** `2026-09-14T20:53:55.440Z` → `14 Sep 2026`. A publish date is a month, not a minute. */
function shortDate(iso: string | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
}

/** `75575` → `76k`. Download counts are a magnitude, and the column is narrow. */
function compactCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/**
 * The sentence every install dialog shows, verbatim, every time.
 *
 * No "don't show again": a pi package's extensions are arbitrary code and its
 * skills instruct the model to act. Someone who has read it ten times loses
 * two seconds; someone who has not is the reason it is here.
 */
const warning = () =>
	t("Packages run with full system access: extensions are code, and skills can tell the model to run anything.");

export function Packages({
	open,
	onChanged,
	cwd,
	onClose,
}: {
	/** The page dialog is showing it: the personality is re-read then. */
	open: boolean;
	/** A package changed: the open session's snapshot is now out of date. */
	onChanged: () => void;
	/** The project on screen, whose own `.pi/settings.json` is shown read-only. */
	cwd: string;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<"installed" | "pwi" | "search">("installed");
	const [project, setProject] = useState<{ cwd: string; packages: PiwPackage[] } | null>(null);
	const [view, setView] = useState<PiwPackagesView | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** A mutation this page started and is still waiting on. */
	const [working, setWorking] = useState<string | undefined>(undefined);
	const [log, setLog] = useState<{ title: string; text: string } | null>(null);
	const [adding, setAdding] = useState<PiwPackageInfo | { source: string } | null>(null);


	const refresh = useCallback(async () => {
		try {
			setView(await parseResponse(api.packages.$get()));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
		// The project's own `.pi/settings.json`, read-only: it is committed and
		// git is its sync, so this is here to answer "why does this project
		// have an extra command", not to be edited.
		void parseResponse(api.packages.project.$get({ query: { cwd } }))
			.then(setProject)
			.catch(() => setProject(null));
	}, [refresh, cwd]);

	/**
	 * Run one mutation and fold the answer back in.
	 *
	 * The log is kept whatever happens: a failed install's last npm line is
	 * the only thing that explains it, and a successful one is worth a look
	 * when a package turns out to be bigger than expected.
	 */
	const mutate = useCallback(
		async (what: string, send: () => Promise<{ json(): Promise<unknown> }>) => {
			setWorking(what);
			let result: PiwMutation;
			try {
				const r = await send();
				result = (await r.json()) as PiwMutation;
			} catch (err) {
				result = { ok: false, log: "", reason: err instanceof Error ? err.message : String(err) };
			}
			setWorking(undefined);
			setLog({
				title: result.ok ? what : t("{what} — failed", { what }),
				text: result.ok ? result.log || t("done") : `${result.reason ?? t("failed")}\n\n${result.log}`,
			});
			await refresh();
			// The open session's `stale` flag only changes server-side, and
			// nothing pushes it: without this the chat keeps claiming it has the
			// current packages until its next turn.
			if (result.ok) onChanged();
		},
		[refresh, onChanged],
	);

	const packages = [...(view?.packages ?? [])].sort((a, b) =>
		a.identity.localeCompare(b.identity),
	);

	/*
	 * A panel in the rail's column now, not a modal.
	 *
	 * It stopped being a dialog when it stopped being something you open ON TOP
	 * of your work: installing a package while reading the session that made you
	 * want it is the actual use, and a modal makes that impossible by design.
	 * The focus trap and Escape binding went with it — neither is wanted for a
	 * panel you tab into and out of like any other column.
	 *
	 * `min-w-0` because the installed table holds absolute node_modules paths,
	 * which would otherwise set the column's floor and defeat the divider.
	 */
	return (
		<section
			aria-label={t("Packages")}
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
		>
			<PanelHeader title={t("Packages")} onClose={onClose}>
				<div className="flex gap-1">
					{(["installed", "pwi", "search"] as const).map((id) => (
						<Button
							key={id}
							variant={tab === id ? "subtle" : "ghost"}
							size="sm"
							onClick={() => setTab(id)}
							aria-pressed={tab === id}
						>
							{id === "installed" ? t("pi packages") : id === "pwi" ? t("pwi extensions") : t("Search")}
						</Button>
					))}
				</div>
				<Button variant="ghost" size="sm" onClick={() => void refresh()}>
					{t("Refresh")}
				</Button>
				<span className="ml-auto flex min-w-0 items-center gap-2 font-mono text-caption text-neutral-500">
					<span className="fade-end" title={t("pi on this machine")}>
						pi {view?.piVersion ?? "?"}
					</span>
					{working && <span className="fade-end text-amber-400">{working}…</span>}
				</span>
			</PanelHeader>

			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				<div className={tab === "installed" ? "" : "hidden"}>
					<Installed
						cwd={cwd}
						packages={packages}
						piVersion={view?.piVersion}
						error={error}
						project={project}
						onAdd={() => setAdding({ source: "" })}
						onUpdate={(source) =>
							void mutate(t("update {source}", { source }), () => api.packages.update.$post({ json: { source } }))
						}
						onRemove={(source) =>
							void mutate(t("remove {source}", { source }), () => api.packages.$delete({ json: { source } }))
						}
						onUpdatePi={() =>
							void mutate(t("update pi"), () => api.packages["update-pi"].$post())
						}
					/>
				</div>
				{/* Hidden, not unmounted, on the other tabs: an unsaved personality edit lives in it. */}
				<div className={tab === "pwi" ? "" : "hidden"}>
					<PwiExtensionsSection open={open} />
				</div>
				{tab === "search" && <Search onPick={setAdding} />}
			</div>

			{adding && (
				<InstallDialog
					target={adding}
					onClose={() => setAdding(null)}
					onInstall={(source) => {
						setAdding(null);
						void mutate(t("install {source}", { source }), () => api.packages.$post({ json: { source } }));
					}}
				/>
			)}

			{log && (
				<div className="border-t border-neutral-800 bg-neutral-900/60 p-3">
					<div className="flex items-center justify-between">
						<span className="font-mono text-meta text-neutral-300">{log.title}</span>
						<Button variant="ghost" size="sm" onClick={() => setLog(null)}>
							{t("Dismiss")}
						</Button>
					</div>
					<pre className="mt-1 max-h-40 overflow-auto font-mono text-meta whitespace-pre-wrap text-neutral-400">
						{stripAnsi(log.text)}
					</pre>
				</div>
			)}
		</section>
	);
}

/** Packages with a settings panel in their row, by identity. */
const hasSettings = (identity: string) => /(^|\/)sol-pi$/i.test(identity);

function Installed({
	cwd,
	packages,
	piVersion,
	error,
	project,
	onAdd,
	onUpdate,
	onRemove,
	onUpdatePi,
}: {
	cwd: string;
	packages: PiwPackage[];
	piVersion: string | null | undefined;
	error: string | null;
	project: { cwd: string; packages: PiwPackage[] } | null;
	onAdd: () => void;
	onUpdate: (source: string) => void;
	onRemove: (source: string) => void;
	onUpdatePi: () => void;
}) {
	const [settingsOf, setSettingsOf] = useState<string | null>(null);
	return (
		<>
			<div className="mb-3 flex items-center gap-2">
				<Button
					size="sm"
					onClick={onAdd}
				>
					{t("Add by source")}
				</Button>
				<span className="text-meta text-neutral-500">
					{t("npm:name@version, git:host/user/repo@ref, or an https/ssh URL")}
				</span>
			</div>

			{error && (
				<div className="mb-3 rounded-sm border border-amber-900 bg-amber-950/30 px-3 py-2 text-meta text-amber-300">
					{error}
				</div>
			)}

			<table className="w-full border-collapse text-ui">
				<thead>
					<tr className={`border-b border-neutral-800 text-left ${sectionLabel}`}>
						<th className="py-1 pr-3 font-normal">{t("Package")}</th>
						<th className="py-1 pr-3 font-normal">{t("Installed")}</th>
					</tr>
				</thead>
				<tbody>
					{packages.map((p) => (
						<Fragment key={p.identity}>
						<tr className="group border-b border-neutral-800 align-top">
							<td className="py-1.5 pr-3">
								<span className="font-mono text-neutral-100">{p.identity}</span>
								<span className="ml-2 text-caption text-neutral-600">{p.kind}</span>
								{hasSettings(p.identity) && (
									<Button
										size="sm"
										variant={settingsOf === p.identity ? "subtle" : "ghost"}
										className="ml-2"
										aria-expanded={settingsOf === p.identity}
										onClick={() => setSettingsOf(settingsOf === p.identity ? null : p.identity)}
									>
										{t("settings")}
									</Button>
								)}
							</td>
							<td className="py-1.5 pr-3">
								<span className="font-mono text-meta text-neutral-300">
									{p.installed ?? t("not on disk")}
								</span>
								{p.pinned && (
									<span
										className="ml-1 rounded-sm bg-neutral-800 px-1 text-caption text-neutral-400"
										title={t("pinned to {version}; package updates skip it", { version: p.pinned })}
									>
										{t("pinned")}
									</span>
								)}
								{p.filtered && (
									<span className="ml-1 text-caption text-neutral-500" title={t("loads only part of itself")}>
										{t("filtered")}
									</span>
								)}
								{!p.autoload && (
									<span
										className="ml-1 text-caption text-neutral-500"
										title={t("installed, but not loaded unless a project asks for it")}
									>
										{t("off")}
									</span>
								)}
								{p.kind !== "local" && (
									<span className="ml-2 inline-flex gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 motion-reduce:transition-none">
										<Button
											size="sm"
											onClick={() => onUpdate(p.source)}
											title={
												p.pinned
													? t("Pinned: an update will not move it. Install the new version to move the pin.")
													: t("Update this package")
											}
										>
											{t("update")}
										</Button>
										<Button
											size="sm"
											onClick={() => onRemove(p.source)}
											title={t("Remove this package")}
										>
											{t("remove")}
										</Button>
									</span>
								)}
							</td>
						</tr>
						{settingsOf === p.identity && (
							<tr className="border-b border-neutral-800">
								<td colSpan={2} className="pt-1">
									<SolPiSettings cwd={cwd} />
								</td>
							</tr>
						)}
						</Fragment>
					))}
					{packages.length === 0 && (
						<tr>
							<td colSpan={2} className="py-6 text-center text-meta text-neutral-500">
								{t("No packages installed yet.")}
							</td>
						</tr>
					)}
				</tbody>
			</table>

			<div className="mt-6 border-t border-neutral-800 pt-3">
				<h3 className={sectionLabel}>{t("pi itself")}</h3>
				<p className="mt-1 max-w-prose text-meta text-neutral-500">
					{t(
						"Extensions declare pi's own packages as peer dependencies, so a machine on a different pi is how a package works on one box and throws on another. Updating is never automatic.",
					)}
				</p>
				<div className="mt-2">
					<Button size="sm" onClick={onUpdatePi}>
						<span className="font-mono">
							pi {piVersion ?? "?"} → {t("update")}
						</span>
					</Button>
				</div>
			</div>

			{project && project.packages.length > 0 && (
				<div className="mt-6 border-t border-neutral-800 pt-3">
					<h3 className={sectionLabel}>
						{t("This project — {cwd}", { cwd: project.cwd })}
					</h3>
					<p className="mt-1 max-w-prose text-meta text-neutral-500">
						{t("From the project's own")} <span className="font-mono">.pi/settings.json</span>.{" "}
						{t(
							"pi installs these at startup once the project is trusted, and the file is usually committed — so git is their sync, and they are read-only here.",
						)}
					</p>
					<ul className="mt-2 space-y-0.5">
						{project.packages.map((p) => (
							<li key={p.source} className="font-mono text-ui text-neutral-300">
								{p.source}
								{p.filtered && <span className="ml-2 text-caption text-neutral-500">{t("filtered")}</span>}
								{!p.autoload && <span className="ml-2 text-caption text-neutral-500">{t("off")}</span>}
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}

/**
 * pi extensions that ship with pwi and load only into the sessions it starts:
 * the tool-metrics switch, and the personality with its reminder.
 */
function PwiExtensionsSection({ open }: { open: boolean }) {
	const [state, setState] = useState<PwiExtensions | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		void api["pwi-extensions"]
			.$get()
			.then((r) => (r.ok ? r.json() : null))
			.then((s) => (s ? setState(s) : setError(t("could not load pwi extensions"))))
			.catch(() => setError(t("could not load pwi extensions")));
	}, []);
	const setToolMetrics = async (on: boolean) => {
		const r = await api["pwi-extensions"]["tool-metrics"].$put({ json: { on } }).catch(() => null);
		if (!r?.ok) return setError(t("could not save the setting"));
		setError(null);
		setState(await r.json());
	};
	const setWorkout = async (on: boolean) => {
		const r = await api["pwi-extensions"].workout.$put({ json: { on } }).catch(() => null);
		if (!r?.ok) return setError(t("could not save the setting"));
		setError(null);
		setState(await r.json());
	};
	const setExercise = async (kind: WorkoutKind, on: boolean) => {
		if (!state) return;
		const off = on ? state.workoutOff.filter((k) => k !== kind) : [...state.workoutOff, kind];
		const r = await api["pwi-extensions"]["workout-exercises"].$put({ json: { off } }).catch(() => null);
		if (!r?.ok) return setError(t("could not save the setting"));
		setError(null);
		setState(await r.json());
	};
	const exercisesOn = WORKOUT_KINDS.filter((k) => !state?.workoutOff.includes(k)).length;
	return (
		<div>
			<h3 className={sectionLabel}>{t("pwi extensions")}</h3>
			<p className="mt-1 max-w-prose text-meta text-neutral-500">
				{t(
					"Built into pwi and loaded only into the sessions it starts, not into pi in a terminal. A change applies to sessions started from now on.",
				)}
			</p>
			{error && <p className="mt-1 text-meta text-red-400">{error}</p>}
			<div className="mt-2 max-w-xl">
				<OptionRow disabled={!state}>
					<input
						type="checkbox"
						checked={state?.toolMetrics ?? false}
						disabled={!state}
						onChange={(e) => void setToolMetrics(e.target.checked)}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Tool metrics")}
						<span className="block text-meta text-neutral-500">
							{t(
								"Times every tool call, and each command inside a bash call with its output size, for Stats and the context panel. Nothing reaches the model.",
							)}
						</span>
					</span>
				</OptionRow>
				<OptionRow disabled={!state}>
					<input
						type="checkbox"
						checked={state?.workout ?? false}
						disabled={!state}
						onChange={(e) => void setWorkout(e.target.checked)}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Workout")}
						<span className="block text-meta text-neutral-500">
							{t(
								"After each prompt goes out, asks for a short exercise while pi answers, rotating muscle groups so the ones just worked rest; Done unlocks when the set is over. Sets show in Stats > Workouts. Applies at once.",
							)}
						</span>
					</span>
				</OptionRow>
				{state?.workout && (
					<Nested>
						<p className="mb-2 text-meta text-neutral-500">{t("pwi picks only from the exercises ticked here.")}</p>
						<div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
							{WORKOUT_KINDS.map((kind) => {
								const on = !state.workoutOff.includes(kind);
								// The last one stays on: with none, the dialog would have nothing to ask for.
								const last = on && exercisesOn === 1;
								return (
									<label
										key={kind}
										title={last ? t("Keep at least one exercise") : undefined}
										className={`flex flex-col items-center gap-1 rounded-sm border p-2 text-meta ${
											on ? "border-neutral-700 text-neutral-200" : "border-neutral-800 text-neutral-500"
										} ${last ? "" : "cursor-pointer hover:bg-neutral-900"}`}
									>
										<WorkoutFigure kind={kind} className={`w-full ${on ? "text-amber-400" : "text-neutral-700"}`} />
										<span className="flex items-center gap-1.5 text-center">
											<input
												type="checkbox"
												checked={on}
												disabled={last}
												onChange={(e) => void setExercise(kind, e.target.checked)}
												className="size-3 shrink-0 accent-amber-400"
											/>
											{exerciseText(kind).name}
										</span>
										<span className="text-center text-neutral-500">{musclesText(kind)}</span>
										{state.workoutProfile && (
											<span className="text-neutral-500">
												{t("≈{n} kcal a set", {
													n: kcalFmt().format(setKcal(kind, EXERCISES[kind].amount, state.workoutProfile)),
												})}
											</span>
										)}
									</label>
								);
							})}
						</div>
						<WorkoutBody profile={state.workoutProfile} onSaved={setState} />
					</Nested>
				)}
				<Personality open={open} />
			</div>
		</div>
	);
}

const kcalFmt = perLocale((l) => new Intl.NumberFormat(l, { maximumFractionDigits: 1 }));

/** Sex, age, height and weight for the calorie estimates; saved together with one button. */
function WorkoutBody({ profile, onSaved }: { profile: WorkoutProfile | null; onSaved: (s: PwiExtensions) => void }) {
	const text = (p: WorkoutProfile | null) => ({
		sex: p?.sex ?? "",
		age: p ? String(p.age) : "",
		heightCm: p ? String(p.heightCm) : "",
		weightKg: p ? String(p.weightKg) : "",
	});
	const [draft, setDraft] = useState(() => text(profile));
	const [error, setError] = useState<string | null>(null);
	const dirty = JSON.stringify(draft) !== JSON.stringify(text(profile));
	const save = async () => {
		const empty = Object.values(draft).every((v) => v.trim() === "");
		const next = empty
			? null
			: { sex: draft.sex, age: Number(draft.age), heightCm: Number(draft.heightCm), weightKg: Number(draft.weightKg) };
		const r = await api["pwi-extensions"]["workout-profile"]
			.$put({ json: { profile: next as WorkoutProfile | null } })
			.catch(() => null);
		if (!r?.ok) return setError(t("Sex, age 10–120, height 100–250 cm and weight 30–300 kg."));
		setError(null);
		onSaved(await r.json());
	};
	const field = (key: "age" | "heightCm" | "weightKg", label: string) => (
		<label className="flex flex-col gap-1">
			{label}
			<input
				value={draft[key]}
				onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
				onKeyDown={(e) => e.key === "Enter" && void save()}
				inputMode="decimal"
				className={`w-20 font-mono ${inputClass.sm}`}
			/>
		</label>
	);
	return (
		<div className="mt-3 text-meta text-neutral-500">
			<p>{t("Your body, for the calorie estimates in Stats > Workouts and on the cards above:")}</p>
			<div className="mt-1 flex flex-wrap items-end gap-2">
				<label className="flex flex-col gap-1">
					{t("Sex")}
					<select
						value={draft.sex}
						onChange={(e) => setDraft({ ...draft, sex: e.target.value })}
						className={`w-24 ${inputClass.sm}`}
					>
						<option value="" disabled>
							{t("Not set")}
						</option>
						<option value="male">{t("Male")}</option>
						<option value="female">{t("Female")}</option>
					</select>
				</label>
				{field("age", t("Age"))}
				{field("heightCm", t("Height, cm"))}
				{field("weightKg", t("Weight, kg"))}
				<Button variant="subtle" size="sm" onClick={() => void save()} disabled={!dirty}>
					{t("Save")}
				</Button>
			</div>
			{error && <p className="mt-1 text-red-400">{error}</p>}
		</div>
	);
}

/**
 * The gallery: npm packages carrying the `pi-package` keyword.
 *
 * Searched through this page's own server rather than from the browser, so
 * there is no third origin to allow and npm learns nothing about who is
 * looking. Git-only packages cannot appear here at all, which is what the
 * "Add by source" box on the other tab is for.
 */
function Search({ onPick }: { onPick: (info: PiwPackageInfo) => void }) {
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<PiwSearchHit[]>([]);
	const [reason, setReason] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		let cancelled = false;
		// Debounced: a search per keystroke would be a request per keystroke,
		// and npm's own results do not change between two letters.
		const timer = setTimeout(async () => {
			setLoading(true);
			try {
				const body = await parseResponse(api.packages.search.$get({ query: { q: query } }));
				if (cancelled) return;
				setHits(body.results);
				setReason(body.reason ?? null);
			} catch (err) {
				if (!cancelled) setReason(err instanceof Error ? err.message : String(err));
			} finally {
				if (!cancelled) setLoading(false);
			}
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query]);

	return (
		<>
			<input
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder={t("Search the pi package gallery")}
				className={`w-full ${inputClass.md}`}
			/>
			{reason && (
				<div className="mt-2 text-meta text-amber-400">
					{t("Could not reach the npm registry: {reason}", { reason })}
				</div>
			)}
			{loading && hits.length === 0 && <div className="mt-3 text-meta text-neutral-500">{t("Searching…")}</div>}
			<ul className="mt-3 space-y-1">
				{hits.map((h) => (
					<li key={h.name}>
						<button
							data-custom="choice card"
							onClick={async () => {
								const info = await parseResponse(api.packages.info.$get({ query: { name: h.name } })).catch(
									() => null,
								);
								if (info) onPick(info);
							}}
							className="block w-full rounded-sm border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left transition-colors duration-150 ease-out hover:border-neutral-700 hover:bg-neutral-900 motion-reduce:transition-none"
						>
							<span className="flex items-baseline gap-2">
								<span className="font-mono text-ui text-neutral-100">{h.name}</span>
								<span className="font-mono text-meta text-neutral-500">{h.version}</span>
								<span className="ml-auto text-meta text-neutral-500">
									{h.publisher} · {shortDate(h.published)}
								</span>
							</span>
							{h.description && (
								<span className="mt-0.5 block text-meta text-neutral-400">{h.description}</span>
							)}
						</button>
					</li>
				))}
			</ul>
			{!loading && hits.length === 0 && !reason && (
				<div className="mt-3 text-meta text-neutral-500">{t("Nothing matches.")}</div>
			)}
		</>
	);
}

/**
 * Confirm one install: what exactly will be installed, and the warning.
 *
 * The source is shown resolved and PINNED — `npm:name@1.4.2`, not
 * `npm:name` — because a pin is what makes a rebuilt machine get the code
 * that was working, rather than whatever published since.
 */
function InstallDialog({
	target,
	onClose,
	onInstall,
}: {
	target: PiwPackageInfo | { source: string };
	onClose: () => void;
	onInstall: (source: string) => void;
}) {
	const known = "name" in target ? target : null;
	const [source, setSource] = useState(known ? `npm:${known.name}@${known.latest}` : "");
	const [error, setError] = useState<string | null>(null);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
			// Escape closes only this, not the page dialog it sits in: a cancelled
			// keydown fires no close request on the <dialog>.
			onKeyDown={(e) => {
				if (e.key !== "Escape") return;
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}}
		>
			<div className="w-[min(34rem,94vw)] rounded-md border border-neutral-800 bg-neutral-950 p-3 shadow-2xl">
				<div className="flex items-center justify-between">
					<h3 className="text-title font-semibold">{known ? t("Install {name}", { name: known.name }) : t("Add a package")}</h3>
					<IconButton
						onClick={onClose}
						label={t("Cancel")}
					>
						<X size={13} />
					</IconButton>
				</div>

				{known && (
					<>
						{known.description && (
							<p className="mt-2 text-meta text-neutral-400">{known.description}</p>
						)}
						<p className="mt-2 flex flex-wrap gap-3 text-meta text-neutral-500">
							<span>{known.publisher}</span>
							<span>{shortDate(known.published)}</span>
							{known.weeklyDownloads !== undefined && (
								<span>{t("{count} downloads/week", { count: compactCount(known.weeklyDownloads) })}</span>
							)}
							<span>
								{t("{ext} ext · {skills} skills · {prompts} prompts · {themes} themes", {
									ext: known.contains.extensions,
									skills: known.contains.skills,
									prompts: known.contains.prompts,
									themes: known.contains.themes,
								})}
							</span>
						</p>
						{known.repository && (
							<a
								href={known.repository}
								target="_blank"
								rel="noreferrer noopener"
								className="mt-1 block font-mono text-meta text-neutral-400 underline"
							>
								{known.repository}
							</a>
						)}
						{known.image && (
							<img
								src={known.image}
								alt=""
								className="mt-2 max-h-48 w-full rounded-sm border border-neutral-800 object-contain"
							/>
						)}
					</>
				)}

				<label className={`mt-3 block ${sectionLabel}`}>
					{t("Source")}
					<input
						value={source}
						onChange={(e) => {
							setSource(e.target.value);
							setError(null);
						}}
						placeholder="npm:my-package@1.0.0"
						className={`mt-1 w-full font-mono normal-case ${inputClass.sm}`}
					/>
				</label>

				<p className="mt-3 rounded-sm border border-amber-900 bg-amber-950/30 px-2 py-1.5 text-meta text-amber-300">
					{warning()}
				</p>

				{error && <p className="mt-2 text-meta text-red-400">{error}</p>}

				<div className="mt-3 flex justify-end gap-2">
					<Button
						onClick={onClose}
					>
						{t("Cancel")}
					</Button>
					<Button
						variant="primary"
						onClick={() => {
							if (!source.trim()) return setError(t("a source is required"));
							onInstall(source.trim());
						}}
					>
						{t("Install")}
					</Button>
				</div>
			</div>
		</div>
	);
}
