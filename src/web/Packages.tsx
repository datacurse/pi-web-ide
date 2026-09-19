/**
 * Packages.tsx — what every machine has installed, and changing it.
 *
 * Two tabs and one table. The table is the whole point: one row per package
 * identity, one column per machine, so "the orangepi is missing pi-lens" is
 * something you SEE rather than something you find out when a session there
 * behaves differently.
 *
 * Every request goes straight to the machine it concerns, at that machine's
 * own origin — the same way the session list already works. This page never
 * proxies one machine's install through another.
 */

import { useCallback, useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import type {
	PiwFleetStatus,
	PiwManifest,
	PiwMutation,
	PiwPackage,
	PiwPackageInfo,
	PiwPackagesView,
	PiwPackageState,
	PiwSearchHit,
} from "../shared/types.js";

/** One machine this screen talks to. `origin` is "" for the page's own server. */
export interface PackageMachine {
	name: string;
	origin: string;
}

/** What one machine answered, or why it did not. */
interface MachineState {
	view?: PiwPackagesView;
	error?: string;
	/** A mutation this page started and is still waiting on. */
	working?: string;
}

/** A row of the installed table: one package, across the fleet. */
interface Row {
	identity: string;
	kind: PiwPackage["kind"];
	/** Per machine name, that machine's entry. Absent means "not installed there". */
	on: Record<string, PiwPackage>;
}

function rowsOf(states: Record<string, MachineState>, machines: PackageMachine[]): Row[] {
	const rows = new Map<string, Row>();
	for (const m of machines) {
		for (const p of states[m.name]?.view?.packages ?? []) {
			const row = rows.get(p.identity) ?? { identity: p.identity, kind: p.kind, on: {} };
			row.on[m.name] = p;
			rows.set(p.identity, row);
		}
	}
	return [...rows.values()].sort((a, b) => a.identity.localeCompare(b.identity));
}

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

async function getJson<T>(origin: string, path: string): Promise<T> {
	const r = await fetch(`${origin}${path}`);
	if (!r.ok) throw new Error(`${r.status}`);
	return (await r.json()) as T;
}

/**
 * The sentence every install dialog shows, verbatim, every time.
 *
 * No "don't show again": a pi package's extensions are arbitrary code and its
 * skills instruct the model to act, on every machine ticked. Someone who has
 * read it ten times loses two seconds; someone who has not is the reason it
 * is here.
 */
const WARNING =
	"Packages run with full system access on every machine ticked: extensions are code, and skills can tell the model to run anything.";

export function Packages({
	open,
	onChanged,
	machines,
	cwd,
	onClose,
}: {
	open: boolean;
	/** A package changed somewhere: the open session's snapshot is now out of date. */
	onChanged: () => void;
	/** This machine first, then every reachable remote. */
	machines: PackageMachine[];
	/** The project on screen, whose own `.pi/settings.json` is shown read-only. */
	cwd: string;
	onClose: () => void;
}) {
	const [tab, setTab] = useState<"installed" | "search" | "fleet">("installed");
	const [project, setProject] = useState<{ cwd: string; packages: PiwPackage[] } | null>(null);
	const [states, setStates] = useState<Record<string, MachineState>>({});
	const [log, setLog] = useState<{ title: string; text: string } | null>(null);
	const [adding, setAdding] = useState<PiwPackageInfo | { source: string } | null>(null);

	const refresh = useCallback(
		async (only?: string) => {
			await Promise.all(
				machines
					.filter((m) => !only || m.name === only)
					.map(async (m) => {
						try {
							const view = await getJson<PiwPackagesView>(m.origin, "/api/packages");
							setStates((s) => ({ ...s, [m.name]: { view } }));
						} catch (err) {
							setStates((s) => ({
								...s,
								[m.name]: { error: err instanceof Error ? err.message : String(err) },
							}));
						}
					}),
			);
		},
		[machines],
	);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// The project's own `.pi/settings.json`, read-only: it is committed and
		// git is its sync, so this is here to answer "why does this project
		// have an extra command", not to be edited.
		void getJson<{ cwd: string; packages: PiwPackage[] }>(
			"",
			`/api/packages/project?cwd=${encodeURIComponent(cwd)}`,
		)
			.then(setProject)
			.catch(() => setProject(null));
	}, [open, refresh, cwd]);

	/**
	 * Run one mutation on one machine and fold the answer back in.
	 *
	 * The log is kept whatever happens: a failed install's last npm line is
	 * the only thing that explains it, and a successful one is worth a look
	 * when a package turns out to be bigger than expected.
	 */
	const mutate = useCallback(
		async (machine: PackageMachine, what: string, path: string, init: RequestInit) => {
			setStates((s) => ({ ...s, [machine.name]: { ...s[machine.name], working: what } }));
			let result: PiwMutation;
			try {
				const r = await fetch(`${machine.origin}${path}`, init);
				result = (await r.json()) as PiwMutation;
			} catch (err) {
				result = { ok: false, log: "", reason: err instanceof Error ? err.message : String(err) };
			}
			setStates((s) => ({ ...s, [machine.name]: { ...s[machine.name], working: undefined } }));
			setLog({
				title: `${what} on ${machine.name || "this machine"}${result.ok ? "" : " — failed"}`,
				text: result.ok ? result.log || "done" : `${result.reason ?? "failed"}\n\n${result.log}`,
			});
			await refresh(machine.name);
			// The open session's `stale` flag only changes server-side, and
			// nothing pushes it: without this the chat keeps claiming it has the
			// current packages until its next turn.
			if (result.ok) onChanged();
		},
		[refresh, onChanged],
	);

	const install = useCallback(
		(machine: PackageMachine, source: string) =>
			mutate(machine, `install ${source}`, "/api/packages", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source }),
			}),
		[mutate],
	);

	if (!open) return null;

	const rows = rowsOf(states, machines);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Packages"
			className="fixed inset-0 z-40 flex flex-col bg-neutral-950 text-neutral-100"
		>
			<div className="flex items-center gap-3 border-b border-neutral-800 px-3 py-2">
				<h2 className="text-sm font-semibold tracking-tight">Packages</h2>
				<div className="flex gap-1">
					{(["installed", "search", "fleet"] as const).map((t) => (
						<button
							key={t}
							onClick={() => setTab(t)}
							aria-pressed={tab === t}
							className={`rounded px-2 py-1 text-xs capitalize transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${
								tab === t ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-900"
							}`}
						>
							{t}
						</button>
					))}
				</div>
				<button
					onClick={() => void refresh()}
					className="rounded px-2 py-1 text-xs text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-900 hover:text-neutral-200 motion-reduce:transition-none"
				>
					Refresh
				</button>
				<span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-neutral-500">
					{machines.map((m) => (
						<span key={m.name} title={`pi on ${m.name || "this machine"}`}>
							{m.name || "this machine"} pi {states[m.name]?.view?.piVersion ?? "?"}
						</span>
					))}
				</span>
				<button
					onClick={onClose}
					aria-label="Close packages"
					className="size-8 shrink-0 rounded text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none"
				>
					<X size={13} />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{tab === "installed" && (
					<Installed
						machines={machines}
						states={states}
						rows={rows}
						project={project}
						onAdd={() => setAdding({ source: "" })}
						onUpdate={(m, source) =>
							void mutate(m, `update ${source}`, "/api/packages/update", {
								method: "POST",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ source }),
							})
						}
						onRemove={(m, source) =>
							void mutate(m, `remove ${source}`, "/api/packages", {
								method: "DELETE",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ source }),
							})
						}
						onUpdatePi={(m) =>
							void mutate(m, "update pi", "/api/packages/update-pi", { method: "POST" })
						}
					/>
				)}
				{tab === "search" && <Search origin={machines[0]?.origin ?? ""} onPick={setAdding} />}
				{tab === "fleet" && <Fleet machines={machines} onChanged={onChanged} />}
			</div>

			{adding && (
				<InstallDialog
					target={adding}
					machines={machines}
					onClose={() => setAdding(null)}
					onInstall={async (source, picked) => {
						setAdding(null);
						for (const m of picked) await install(m, source);
					}}
				/>
			)}

			{log && (
				<div className="border-t border-neutral-800 bg-neutral-900/60 p-3">
					<div className="flex items-center justify-between">
						<span className="font-mono text-xs text-neutral-300">{log.title}</span>
						<button
							onClick={() => setLog(null)}
							className="rounded px-2 text-xs text-neutral-500 hover:text-neutral-200"
						>
							dismiss
						</button>
					</div>
					<pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-neutral-400">
						{log.text}
					</pre>
				</div>
			)}
		</div>
	);
}

function Installed({
	machines,
	states,
	rows,
	project,
	onAdd,
	onUpdate,
	onRemove,
	onUpdatePi,
}: {
	machines: PackageMachine[];
	states: Record<string, MachineState>;
	rows: Row[];
	project: { cwd: string; packages: PiwPackage[] } | null;
	onAdd: () => void;
	onUpdate: (machine: PackageMachine, source: string) => void;
	onRemove: (machine: PackageMachine, source: string) => void;
	onUpdatePi: (machine: PackageMachine) => void;
}) {
	return (
		<>
			<div className="mb-3 flex items-center gap-2">
				<button
					onClick={onAdd}
					className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 transition-colors duration-150 ease-out hover:bg-neutral-900 motion-reduce:transition-none"
				>
					Add by source
				</button>
				<span className="text-xs text-neutral-500">
					npm:name@version, git:host/user/repo@ref, or an https/ssh URL
				</span>
			</div>

			{machines.some((m) => states[m.name]?.error) && (
				<div className="mb-3 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
					{machines
						.filter((m) => states[m.name]?.error)
						.map((m) => `${m.name || "this machine"}: ${states[m.name]?.error}`)
						.join(" · ")}
				</div>
			)}

			<table className="w-full border-collapse text-sm">
				<thead>
					<tr className="border-b border-neutral-800 text-left text-[10px] tracking-wide text-neutral-500 uppercase">
						<th className="py-1 pr-3 font-normal">Package</th>
						{machines.map((m) => (
							<th key={m.name} className="py-1 pr-3 font-normal">
								{m.name || "this machine"}
								{states[m.name]?.working && (
									<span className="ml-1 text-amber-400">{states[m.name]?.working}…</span>
								)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.identity} className="border-b border-neutral-900 align-top">
							<td className="py-1.5 pr-3">
								<span className="font-mono text-neutral-100">{row.identity}</span>
								<span className="ml-2 text-[10px] text-neutral-600">{row.kind}</span>
							</td>
							{machines.map((m) => {
								const p = row.on[m.name];
								if (!p) {
									return (
										<td key={m.name} className="py-1.5 pr-3 text-neutral-700">
											—
										</td>
									);
								}
								return (
									<td key={m.name} className="group py-1.5 pr-3">
										<span className="font-mono text-xs text-neutral-300">
											{p.installed ?? "not on disk"}
										</span>
										{p.pinned && (
											<span
												className="ml-1 rounded bg-neutral-800 px-1 text-[10px] text-neutral-400"
												title={`pinned to ${p.pinned}; package updates skip it`}
											>
												pinned
											</span>
										)}
										{p.filtered && (
											<span className="ml-1 text-[10px] text-neutral-500" title="loads only part of itself">
												filtered
											</span>
										)}
										{!p.autoload && (
											<span
												className="ml-1 text-[10px] text-neutral-500"
												title="installed, but not loaded unless a project asks for it"
											>
												off
											</span>
										)}
										{p.kind !== "local" && (
											<span className="ml-2 inline-flex gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 motion-reduce:transition-none">
												<button
													onClick={() => onUpdate(m, p.source)}
													title={
														p.pinned
															? "Pinned: an update will not move it. Install the new version to move the pin."
															: "Update this package on this machine"
													}
													className="rounded border border-neutral-700 px-1 text-[10px] text-neutral-300 hover:bg-neutral-800"
												>
													update
												</button>
												<button
													onClick={() => onRemove(m, p.source)}
													title="Remove this package from this machine"
													className="rounded border border-neutral-700 px-1 text-[10px] text-neutral-300 hover:bg-neutral-800"
												>
													remove
												</button>
											</span>
										)}
									</td>
								);
							})}
						</tr>
					))}
					{rows.length === 0 && (
						<tr>
							<td colSpan={machines.length + 1} className="py-6 text-center text-xs text-neutral-500">
								No packages installed yet.
							</td>
						</tr>
					)}
				</tbody>
			</table>

			<div className="mt-6 border-t border-neutral-900 pt-3">
				<h3 className="text-[10px] tracking-wide text-neutral-500 uppercase">pi itself</h3>
				<p className="mt-1 max-w-prose text-xs text-neutral-500">
					Extensions declare pi's own packages as peer dependencies, so a machine on a different pi is
					how a package works on one box and throws on another. Updating is per machine and never
					automatic.
				</p>
				<div className="mt-2 flex flex-wrap gap-2">
					{machines.map((m) => (
						<button
							key={m.name}
							onClick={() => onUpdatePi(m)}
							className="rounded border border-neutral-700 px-2 py-1 font-mono text-xs text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-900 motion-reduce:transition-none"
						>
							{m.name || "this machine"}: pi {states[m.name]?.view?.piVersion ?? "?"} → update
						</button>
					))}
				</div>
			</div>

			{project && project.packages.length > 0 && (
				<div className="mt-6 border-t border-neutral-900 pt-3">
					<h3 className="text-[10px] tracking-wide text-neutral-500 uppercase">
						This project — {project.cwd}
					</h3>
					<p className="mt-1 max-w-prose text-xs text-neutral-500">
						From the project's own <span className="font-mono">.pi/settings.json</span>. pi installs
						these at startup once the project is trusted, and the file is usually committed — so git
						is their sync, and they are read-only here.
					</p>
					<ul className="mt-2 space-y-0.5">
						{project.packages.map((p) => (
							<li key={p.source} className="font-mono text-xs text-neutral-300">
								{p.source}
								{p.filtered && <span className="ml-2 text-[10px] text-neutral-500">filtered</span>}
								{!p.autoload && <span className="ml-2 text-[10px] text-neutral-500">off</span>}
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}

/**
 * The manifest, and what every machine has done about it.
 *
 * This is the only tab that describes a fleet rather than a machine. The
 * table below it is a report, not a control surface: reconciliation happens
 * in the hub's server on a timer and when a machine comes back, so what is
 * shown here is the last thing that actually happened, timestamp included.
 */
function Fleet({
	machines,
	onChanged,
}: {
	machines: PackageMachine[];
	onChanged: () => void;
}) {
	const [manifest, setManifest] = useState<PiwManifest>({ version: 1, packages: [] });
	const [status, setStatus] = useState<PiwFleetStatus>({});
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const body = await getJson<{ manifest: PiwManifest; status: PiwFleetStatus }>(
				"",
				"/api/fleet",
			);
			setManifest(body.manifest);
			setStatus(body.status);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/**
	 * The manifest is edited as JSON, on purpose.
	 *
	 * It is a short list of pinned sources with the occasional `exclude`, it
	 * is a file the owner may also edit by hand or commit, and a form would
	 * hide exactly the field — `exclude` — that is worth seeing in full. The
	 * server validates every entry and says which one it refused.
	 */
	const text = draft ?? `${JSON.stringify(manifest, null, "\t")}\n`;

	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const parsed: unknown = JSON.parse(text);
			const r = await fetch("/api/fleet", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(parsed),
			});
			const body: unknown = await r.json();
			if (!r.ok) {
				setError(
					isRecordLike(body) && typeof body.error === "string" ? body.error : `save failed (${r.status})`,
				);
				return;
			}
			if (isRecordLike(body)) {
				setManifest(body.manifest as PiwManifest);
				setStatus(body.status as PiwFleetStatus);
			}
			setDraft(null);
			onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const sync = async () => {
		setBusy(true);
		try {
			const body = await getJson<{ status: PiwFleetStatus }>("", "/api/fleet/sync");
			setStatus(body.status);
			onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const adopt = async (source: string, version: string | null) => {
		setBusy(true);
		try {
			const r = await fetch("/api/fleet/adopt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source, installed: version }),
			});
			const body: unknown = await r.json();
			if (!r.ok) {
				setError(isRecordLike(body) && typeof body.error === "string" ? body.error : "adopt failed");
				return;
			}
			await load();
			onChanged();
		} finally {
			setBusy(false);
		}
	};

	// Every machine the status knows about, plus every machine on screen: a
	// machine that has never been reconciled still needs a column.
	const names = [...new Set([...machines.map((m) => m.name), ...Object.keys(status)])];
	const identities = [
		...new Set(names.flatMap((n) => Object.keys(status[n]?.packages ?? {}))),
	].sort();

	return (
		<>
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<h3 className="text-[10px] tracking-wide text-neutral-500 uppercase">Manifest</h3>
					<p className="mt-1 max-w-prose text-xs text-neutral-500">
						One desired state for the fleet. Every source must be pinned, because a pin is what
						makes every machine run the same code. A machine that was off catches up on its own when
						it comes back — nothing here fans out.
					</p>
					<textarea
						value={text}
						onChange={(e) => {
							setDraft(e.target.value);
							setError(null);
						}}
						spellCheck={false}
						rows={10}
						className="mt-2 w-full resize-y rounded border border-neutral-800 bg-neutral-900 p-2 font-mono text-xs text-neutral-200 outline-none focus:border-neutral-600"
					/>
					<div className="mt-2 flex items-center gap-2">
						<button
							onClick={() => void save()}
							disabled={busy || draft === null}
							className="rounded bg-amber-500 px-3 py-1 text-xs font-medium text-neutral-950 transition-colors duration-150 ease-out enabled:hover:bg-amber-400 disabled:opacity-40 motion-reduce:transition-none"
						>
							Save and reconcile
						</button>
						<button
							onClick={() => void sync()}
							disabled={busy}
							className="rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 transition-colors duration-150 ease-out enabled:hover:bg-neutral-900 disabled:opacity-40 motion-reduce:transition-none"
						>
							Sync now
						</button>
						{draft !== null && (
							<button
								onClick={() => {
									setDraft(null);
									setError(null);
								}}
								className="rounded px-2 py-1 text-xs text-neutral-500 hover:text-neutral-200"
							>
								revert
							</button>
						)}
						{busy && <span className="text-xs text-amber-400">working…</span>}
					</div>
					{error && <p className="mt-2 text-xs text-red-400">{error}</p>}
				</div>
			</div>

			<h3 className="mt-6 text-[10px] tracking-wide text-neutral-500 uppercase">Convergence</h3>
			<table className="mt-1 w-full border-collapse text-sm">
				<thead>
					<tr className="border-b border-neutral-800 text-left text-[10px] tracking-wide text-neutral-500 uppercase">
						<th className="py-1 pr-3 font-normal">Package</th>
						{names.map((n) => (
							<th key={n} className="py-1 pr-3 font-normal">
								{n || "this machine"}
								{status[n] && !status[n].reachable && (
									<span className="ml-1 text-amber-400" title={status[n].error}>
										unreachable
									</span>
								)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{identities.map((identity) => (
						<tr key={identity} className="border-b border-neutral-900 align-top">
							<td className="py-1.5 pr-3 font-mono text-xs text-neutral-100">{identity}</td>
							{names.map((n) => {
								const st = status[n]?.packages[identity];
								return (
									<td key={n} className="py-1.5 pr-3 text-xs">
										<StateCell
											state={st}
											onAdopt={
												st?.state === "unmanaged"
													? () => void adopt(sourceOf(identity), st.version)
													: undefined
											}
										/>
									</td>
								);
							})}
						</tr>
					))}
					{identities.length === 0 && (
						<tr>
							<td colSpan={names.length + 1} className="py-6 text-center text-xs text-neutral-500">
								Nothing reconciled yet. Save a manifest, or press Sync now.
							</td>
						</tr>
					)}
				</tbody>
			</table>
			<p className="mt-2 text-[10px] text-neutral-600">
				{names
					.filter((n) => status[n])
					.map((n) => `${n || "this machine"}: ${new Date(status[n].at).toLocaleTimeString()}`)
					.join(" · ")}
			</p>
		</>
	);
}

/** A package identity back to the source that installs it. npm is the only guess worth making. */
function sourceOf(identity: string): string {
	return identity.includes("/") && identity.includes(".") ? `git:${identity}` : `npm:${identity}`;
}

function isRecordLike(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function StateCell({
	state,
	onAdopt,
}: {
	state: PiwPackageState | undefined;
	onAdopt?: () => void;
}) {
	if (!state) return <span className="text-neutral-700">—</span>;
	if (state.state === "ok")
		return <span className="font-mono text-emerald-400">{state.version ?? "ok"}</span>;
	if (state.state === "installing") return <span className="text-amber-400">installing…</span>;
	if (state.state === "excluded") return <span className="text-neutral-500">excluded</span>;
	if (state.state === "failed")
		return (
			<span className="text-red-400" title={state.log}>
				{state.reason}
			</span>
		);
	return (
		<span className="text-neutral-400">
			<span className="font-mono">{state.version ?? "installed"}</span>
			<span className="ml-1 text-[10px]">unmanaged</span>
			{onAdopt && (
				<button
					onClick={onAdopt}
					title="Add it to the manifest at the version it is running"
					className="ml-2 rounded border border-neutral-700 px-1 text-[10px] text-neutral-300 hover:bg-neutral-800"
				>
					adopt
				</button>
			)}
		</span>
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
function Search({
	origin,
	onPick,
}: {
	origin: string;
	onPick: (info: PiwPackageInfo) => void;
}) {
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
					origin,
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
	}, [query, origin]);

	return (
		<>
			<input
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search the pi package gallery"
				className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
			/>
			{reason && (
				<div className="mt-2 text-xs text-amber-400">
					Could not reach the npm registry: {reason}
				</div>
			)}
			{loading && hits.length === 0 && <div className="mt-3 text-xs text-neutral-500">Searching…</div>}
			<ul className="mt-3 space-y-1">
				{hits.map((h) => (
					<li key={h.name}>
						<button
							onClick={async () => {
								const info = await getJson<PiwPackageInfo>(
									origin,
									`/api/packages/info?name=${encodeURIComponent(h.name)}`,
								).catch(() => null);
								if (info) onPick(info);
							}}
							className="block w-full rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left transition-colors duration-150 ease-out hover:border-neutral-700 hover:bg-neutral-900 motion-reduce:transition-none"
						>
							<span className="flex items-baseline gap-2">
								<span className="font-mono text-sm text-neutral-100">{h.name}</span>
								<span className="font-mono text-xs text-neutral-500">{h.version}</span>
								<span className="ml-auto text-[10px] text-neutral-500">
									{h.publisher} · {shortDate(h.published)}
								</span>
							</span>
							{h.description && (
								<span className="mt-0.5 block text-xs text-neutral-400">{h.description}</span>
							)}
						</button>
					</li>
				))}
			</ul>
			{!loading && hits.length === 0 && !reason && (
				<div className="mt-3 text-xs text-neutral-500">Nothing matches.</div>
			)}
		</>
	);
}

/**
 * Confirm one install: what exactly will be installed, where, and the
 * warning.
 *
 * The source is shown resolved and PINNED — `npm:name@1.4.2`, not
 * `npm:name` — because a pin is what makes every machine run the same code,
 * and because the version installed today is the one the fleet should get
 * tomorrow when a machine that was asleep catches up.
 */
function InstallDialog({
	target,
	machines,
	onClose,
	onInstall,
}: {
	target: PiwPackageInfo | { source: string };
	machines: PackageMachine[];
	onClose: () => void;
	onInstall: (source: string, machines: PackageMachine[]) => void;
}) {
	const known = "name" in target ? target : null;
	const [source, setSource] = useState(known ? `npm:${known.name}@${known.latest}` : "");
	const [picked, setPicked] = useState<string[]>(machines.map((m) => m.name));
	const [error, setError] = useState<string | null>(null);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
			<div className="w-[min(34rem,94vw)] rounded-lg border border-neutral-800 bg-neutral-950 p-3 shadow-2xl">
				<div className="flex items-center justify-between">
					<h3 className="text-sm font-semibold">{known ? `Install ${known.name}` : "Add a package"}</h3>
					<button
						onClick={onClose}
						aria-label="Cancel"
						className="size-8 rounded text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
					>
						<X size={13} />
					</button>
				</div>

				{known && (
					<>
						{known.description && (
							<p className="mt-2 text-xs text-neutral-400">{known.description}</p>
						)}
						<p className="mt-2 flex flex-wrap gap-3 text-[11px] text-neutral-500">
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
								className="mt-1 block font-mono text-[11px] text-neutral-400 underline"
							>
								{known.repository}
							</a>
						)}
						{known.image && (
							<img
								src={known.image}
								alt=""
								className="mt-2 max-h-48 w-full rounded border border-neutral-800 object-contain"
							/>
						)}
					</>
				)}

				<label className="mt-3 block text-[10px] tracking-wide text-neutral-500 uppercase">
					Source
					<input
						value={source}
						onChange={(e) => {
							setSource(e.target.value);
							setError(null);
						}}
						placeholder="npm:my-package@1.0.0"
						className="mt-1 w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 font-mono text-xs text-neutral-100 normal-case outline-none focus:border-neutral-600"
					/>
				</label>

				<fieldset className="mt-3 border-0 p-0">
					<legend className="text-[10px] tracking-wide text-neutral-500 uppercase">Machines</legend>
					<div className="mt-1 flex flex-wrap gap-3">
						{machines.map((m) => (
							<label key={m.name} className="flex items-center gap-1.5 text-xs text-neutral-300">
								<input
									type="checkbox"
									checked={picked.includes(m.name)}
									onChange={(e) =>
										setPicked((p) =>
											e.target.checked ? [...p, m.name] : p.filter((n) => n !== m.name),
										)
									}
								/>
								{m.name || "this machine"}
							</label>
						))}
					</div>
				</fieldset>

				<p className="mt-3 rounded border border-amber-900 bg-amber-950/30 px-2 py-1.5 text-xs text-amber-300">
					{WARNING}
				</p>

				{error && <p className="mt-2 text-xs text-red-400">{error}</p>}

				<div className="mt-3 flex justify-end gap-2">
					<button
						onClick={onClose}
						className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-900"
					>
						Cancel
					</button>
					<button
						onClick={() => {
							if (!source.trim()) return setError("a source is required");
							if (picked.length === 0) return setError("pick at least one machine");
							onInstall(
								source.trim(),
								machines.filter((m) => picked.includes(m.name)),
							);
						}}
						className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-amber-400"
					>
						Install
					</button>
				</div>
			</div>
		</div>
	);
}
