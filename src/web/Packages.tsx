/**
 * Packages.tsx — what this machine has installed, and changing it.
 *
 * Two tabs and one table: what is installed here, and the gallery to add
 * from. Every machine runs its own pwi, so "the orangepi is missing pi-lens"
 * is answered by opening the orangepi's pwi, not by this page reaching
 * across — which means no cross-origin requests and no manifest to converge
 * on.
 */

import { useCallback, useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { stripAnsi } from "fancy-ansi";
import type {
	PiwMutation,
	PiwPackage,
	PiwPackageInfo,
	PiwPackagesView,
	PiwSearchHit,
} from "../shared/types.js";
import { Button, IconButton, PanelHeader, inputClass, sectionLabel } from "./ui.js";

/** `2026-09-14T20:53:55.440Z` → `14 Sep 2026`. A publish date is a month, not a minute. */
function shortDate(iso: string | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** `75575` → `76k`. Download counts are a magnitude, and the column is narrow. */
function compactCount(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

async function getJson<T>(path: string): Promise<T> {
	const r = await fetch(path);
	if (!r.ok) throw new Error(`${r.status}`);
	return (await r.json()) as T;
}

/**
 * The sentence every install dialog shows, verbatim, every time.
 *
 * No "don't show again": a pi package's extensions are arbitrary code and its
 * skills instruct the model to act. Someone who has read it ten times loses
 * two seconds; someone who has not is the reason it is here.
 */
const WARNING =
	"Packages run with full system access: extensions are code, and skills can tell the model to run anything.";

export function Packages({
	onChanged,
	cwd,
	onClose,
}: {
	/** A package changed: the open session's snapshot is now out of date. */
	onChanged: () => void;
	/** The project on screen, whose own `.pi/settings.json` is shown read-only. */
	cwd: string;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<"installed" | "search">("installed");
	const [project, setProject] = useState<{ cwd: string; packages: PiwPackage[] } | null>(null);
	const [view, setView] = useState<PiwPackagesView | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** A mutation this page started and is still waiting on. */
	const [working, setWorking] = useState<string | undefined>(undefined);
	const [log, setLog] = useState<{ title: string; text: string } | null>(null);
	const [adding, setAdding] = useState<PiwPackageInfo | { source: string } | null>(null);


	const refresh = useCallback(async () => {
		try {
			setView(await getJson<PiwPackagesView>("/api/packages"));
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
		void getJson<{ cwd: string; packages: PiwPackage[] }>(
			`/api/packages/project?cwd=${encodeURIComponent(cwd)}`,
		)
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
		async (what: string, path: string, init: RequestInit) => {
			setWorking(what);
			let result: PiwMutation;
			try {
				const r = await fetch(path, init);
				result = (await r.json()) as PiwMutation;
			} catch (err) {
				result = { ok: false, log: "", reason: err instanceof Error ? err.message : String(err) };
			}
			setWorking(undefined);
			setLog({
				title: `${what}${result.ok ? "" : " — failed"}`,
				text: result.ok ? result.log || "done" : `${result.reason ?? "failed"}\n\n${result.log}`,
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
			aria-label="Packages"
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
		>
			<PanelHeader title="Packages" onClose={onClose}>
				<div className="flex gap-1">
					{(["installed", "search"] as const).map((t) => (
						<Button
							key={t}
							variant={tab === t ? "subtle" : "ghost"}
							size="sm"
							onClick={() => setTab(t)}
							aria-pressed={tab === t}
						>
							{t === "installed" ? "Installed" : "Search"}
						</Button>
					))}
				</div>
				<Button variant="ghost" size="sm" onClick={() => void refresh()}>
					Refresh
				</Button>
				<span className="ml-auto flex min-w-0 items-center gap-2 font-mono text-caption text-neutral-500">
					<span className="truncate" title="pi on this machine">
						pi {view?.piVersion ?? "?"}
					</span>
					{working && <span className="truncate text-amber-400">{working}…</span>}
				</span>
			</PanelHeader>

			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{tab === "installed" && (
					<Installed
						packages={packages}
						piVersion={view?.piVersion}
						error={error}
						project={project}
						onAdd={() => setAdding({ source: "" })}
						onUpdate={(source) =>
							void mutate(`update ${source}`, "/api/packages/update", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ source }),
							})
						}
						onRemove={(source) =>
							void mutate(`remove ${source}`, "/api/packages", {
								method: "DELETE",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ source }),
							})
						}
						onUpdatePi={() =>
							void mutate("update pi", "/api/packages/update-pi", { method: "POST" })
						}
					/>
				)}
				{tab === "search" && <Search onPick={setAdding} />}
			</div>

			{adding && (
				<InstallDialog
					target={adding}
					onClose={() => setAdding(null)}
					onInstall={(source) => {
						setAdding(null);
						void mutate(`install ${source}`, "/api/packages", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ source }),
						});
					}}
				/>
			)}

			{log && (
				<div className="border-t border-neutral-800 bg-neutral-900/60 p-3">
					<div className="flex items-center justify-between">
						<span className="font-mono text-meta text-neutral-300">{log.title}</span>
						<Button variant="ghost" size="sm" onClick={() => setLog(null)}>
							Dismiss
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

function Installed({
	packages,
	piVersion,
	error,
	project,
	onAdd,
	onUpdate,
	onRemove,
	onUpdatePi,
}: {
	packages: PiwPackage[];
	piVersion: string | null | undefined;
	error: string | null;
	project: { cwd: string; packages: PiwPackage[] } | null;
	onAdd: () => void;
	onUpdate: (source: string) => void;
	onRemove: (source: string) => void;
	onUpdatePi: () => void;
}) {
	return (
		<>
			<div className="mb-3 flex items-center gap-2">
				<Button
					size="sm"
					onClick={onAdd}
				>
					Add by source
				</Button>
				<span className="text-meta text-neutral-500">
					npm:name@version, git:host/user/repo@ref, or an https/ssh URL
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
						<th className="py-1 pr-3 font-normal">Package</th>
						<th className="py-1 pr-3 font-normal">Installed</th>
					</tr>
				</thead>
				<tbody>
					{packages.map((p) => (
						<tr key={p.identity} className="group border-b border-neutral-900 align-top">
							<td className="py-1.5 pr-3">
								<span className="font-mono text-neutral-100">{p.identity}</span>
								<span className="ml-2 text-caption text-neutral-600">{p.kind}</span>
							</td>
							<td className="py-1.5 pr-3">
								<span className="font-mono text-meta text-neutral-300">
									{p.installed ?? "not on disk"}
								</span>
								{p.pinned && (
									<span
										className="ml-1 rounded-sm bg-neutral-800 px-1 text-caption text-neutral-400"
										title={`pinned to ${p.pinned}; package updates skip it`}
									>
										pinned
									</span>
								)}
								{p.filtered && (
									<span className="ml-1 text-caption text-neutral-500" title="loads only part of itself">
										filtered
									</span>
								)}
								{!p.autoload && (
									<span
										className="ml-1 text-caption text-neutral-500"
										title="installed, but not loaded unless a project asks for it"
									>
										off
									</span>
								)}
								{p.kind !== "local" && (
									<span className="ml-2 inline-flex gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 motion-reduce:transition-none">
										<Button
											size="sm"
											onClick={() => onUpdate(p.source)}
											title={
												p.pinned
													? "Pinned: an update will not move it. Install the new version to move the pin."
													: "Update this package"
											}
										>
											update
										</Button>
										<Button
											size="sm"
											onClick={() => onRemove(p.source)}
											title="Remove this package"
										>
											remove
										</Button>
									</span>
								)}
							</td>
						</tr>
					))}
					{packages.length === 0 && (
						<tr>
							<td colSpan={2} className="py-6 text-center text-meta text-neutral-500">
								No packages installed yet.
							</td>
						</tr>
					)}
				</tbody>
			</table>

			<div className="mt-6 border-t border-neutral-900 pt-3">
				<h3 className={sectionLabel}>pi itself</h3>
				<p className="mt-1 max-w-prose text-meta text-neutral-500">
					Extensions declare pi's own packages as peer dependencies, so a machine on a different pi is
					how a package works on one box and throws on another. Updating is never automatic.
				</p>
				<div className="mt-2">
					<Button size="sm" onClick={onUpdatePi}>
						<span className="font-mono">pi {piVersion ?? "?"} → update</span>
					</Button>
				</div>
			</div>

			{project && project.packages.length > 0 && (
				<div className="mt-6 border-t border-neutral-900 pt-3">
					<h3 className={sectionLabel}>
						This project — {project.cwd}
					</h3>
					<p className="mt-1 max-w-prose text-meta text-neutral-500">
						From the project's own <span className="font-mono">.pi/settings.json</span>. pi installs
						these at startup once the project is trusted, and the file is usually committed — so git
						is their sync, and they are read-only here.
					</p>
					<ul className="mt-2 space-y-0.5">
						{project.packages.map((p) => (
							<li key={p.source} className="font-mono text-ui text-neutral-300">
								{p.source}
								{p.filtered && <span className="ml-2 text-caption text-neutral-500">filtered</span>}
								{!p.autoload && <span className="ml-2 text-caption text-neutral-500">off</span>}
							</li>
						))}
					</ul>
				</div>
			)}
		</>
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
				const body = await getJson<{ results: PiwSearchHit[]; reason?: string }>(
					`/api/packages/search?q=${encodeURIComponent(query)}`,
				);
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
				placeholder="Search the pi package gallery"
				className={`w-full ${inputClass.md}`}
			/>
			{reason && (
				<div className="mt-2 text-meta text-amber-400">
					Could not reach the npm registry: {reason}
				</div>
			)}
			{loading && hits.length === 0 && <div className="mt-3 text-meta text-neutral-500">Searching…</div>}
			<ul className="mt-3 space-y-1">
				{hits.map((h) => (
					<li key={h.name}>
						<button
							data-custom="choice card"
							onClick={async () => {
								const info = await getJson<PiwPackageInfo>(
									`/api/packages/info?name=${encodeURIComponent(h.name)}`,
								).catch(() => null);
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
				<div className="mt-3 text-meta text-neutral-500">Nothing matches.</div>
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
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
			<div className="w-[min(34rem,94vw)] rounded-md border border-neutral-800 bg-neutral-950 p-3 shadow-2xl">
				<div className="flex items-center justify-between">
					<h3 className="text-title font-semibold">{known ? `Install ${known.name}` : "Add a package"}</h3>
					<IconButton
						onClick={onClose}
						label="Cancel"
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
								<span>{compactCount(known.weeklyDownloads)} downloads/week</span>
							)}
							<span>
								{known.contains.extensions} ext · {known.contains.skills} skills ·{" "}
								{known.contains.prompts} prompts · {known.contains.themes} themes
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
					Source
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
					{WARNING}
				</p>

				{error && <p className="mt-2 text-meta text-red-400">{error}</p>}

				<div className="mt-3 flex justify-end gap-2">
					<Button
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						variant="primary"
						onClick={() => {
							if (!source.trim()) return setError("a source is required");
							onInstall(source.trim());
						}}
					>
						Install
					</Button>
				</div>
			</div>
		</div>
	);
}
