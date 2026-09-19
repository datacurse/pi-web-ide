/**
 * fleet.ts — one desired state, converged on by every machine.
 *
 * The model is deliberately NOT fan-out. A browser that installs a package
 * on three machines at once leaves the fourth — the one that was asleep —
 * behind forever, and nothing ever notices. So the hub owns a manifest, and
 * reconciliation runs HERE, in the server, on a timer and on reachability
 * changes. A machine that was down catches up the moment it comes back, with
 * no tab open anywhere.
 *
 * Every entry in the manifest is pinned, and that is enforced at write time.
 * A pin is what makes "the fleet runs the same code" true rather than
 * aspirational, and it makes an upgrade an explicit, reviewable edit of one
 * string instead of a race between machines' clocks.
 *
 * Two things this never does: it never removes a package it did not install
 * (a package on a machine but not in the manifest is reported as unmanaged,
 * and adopting or removing it is the owner's decision), and it never touches
 * a machine whose `/api/health` does not name this product.
 */

import { isRecord, records } from "./guards.js";
import { listHosts } from "./hosts.js";
import * as packages from "./packages.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";
import type { Tunnels } from "./tunnels.js";
import type {
	PiwFleetStatus,
	PiwHostStatus,
	PiwMachineState,
	PiwManifest,
	PiwManifestEntry,
	PiwPackageState,
} from "../shared/types.js";

/** How often reachability is re-checked, which is also how a sleeping machine catches up. */
const POLL_MS = Number(process.env.PIW_FLEET_POLL_MS ?? 60_000);

/** A remote is asked over a loopback forward or a tailnet name; neither is slow. */
const REMOTE_TIMEOUT_MS = 10_000;

/** One install on a remote can clone and npm-install, exactly as it can here. */
const REMOTE_MUTATION_MS = Number(process.env.PIW_PACKAGES_TIMEOUT_MS ?? 300_000);

/** This machine, in a list of machines. The empty name is what the UI already uses. */
const LOCAL = "";

export type Manifest = PiwManifest;
export type ManifestEntry = PiwManifestEntry;
export type PackageState = PiwPackageState;
export type MachineState = PiwMachineState;
export type FleetStatus = PiwFleetStatus;

const MANIFEST_FILE = "packages.json";
const STATUS_FILE = "sync-status.json";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function readManifest(): Manifest {
	const text = readStateFile(statePath(MANIFEST_FILE));
	if (!text) return { version: 1, packages: [] };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		// A hand-edited file with a trailing comma must not take the fleet
		// down; an empty manifest reconciles to "leave everything alone".
		return { version: 1, packages: [] };
	}
	if (!isRecord(raw)) return { version: 1, packages: [] };

	const entries: ManifestEntry[] = [];
	for (const e of records(raw.packages)) {
		if (typeof e.source !== "string") continue;
		const exclude = Array.isArray(e.exclude)
			? e.exclude.filter((x): x is string => typeof x === "string")
			: undefined;
		entries.push({ source: e.source, ...(exclude?.length ? { exclude } : {}) });
	}
	return { version: 1, packages: entries };
}

/**
 * Replace the manifest, refusing anything that would defeat its purpose.
 *
 * Unpinned is the refusal that matters: without a pin, two machines that
 * reconcile a week apart install two different versions and the fleet has
 * quietly stopped being one fleet.
 */
export function writeManifest(input: unknown): Manifest {
	if (!isRecord(input)) throw new Error("manifest must be an object");

	const seen = new Set<string>();
	const entries: ManifestEntry[] = [];
	for (const e of records(input.packages)) {
		if (typeof e.source !== "string" || !e.source.trim()) {
			throw new Error("every entry needs a source");
		}
		const parsed = packages.validate(e.source.trim());
		if (!parsed.pinned) {
			throw new Error(
				`${parsed.source} is not pinned — use npm:<name>@<version> or git:<host>/<path>@<tag>`,
			);
		}
		if (seen.has(parsed.identity)) throw new Error(`${parsed.identity} is listed twice`);
		seen.add(parsed.identity);

		const exclude = Array.isArray(e.exclude)
			? e.exclude.filter((x): x is string => typeof x === "string")
			: [];
		entries.push({ source: parsed.source, ...(exclude.length ? { exclude } : {}) });
	}

	const manifest: Manifest = { version: 1, packages: entries };
	writeStateFile(statePath(MANIFEST_FILE), `${JSON.stringify(manifest, null, "\t")}\n`, 0o644);
	return manifest;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

let status: FleetStatus = load();

function load(): FleetStatus {
	const text = readStateFile(statePath(STATUS_FILE));
	if (!text) return {};
	try {
		const raw: unknown = JSON.parse(text);
		return isRecord(raw) ? (raw as FleetStatus) : {};
	} catch {
		return {};
	}
}

function persist(): void {
	try {
		writeStateFile(statePath(STATUS_FILE), `${JSON.stringify(status, null, "\t")}\n`, 0o644);
	} catch {
		// Status is a report, not a source of truth: losing it costs a line in
		// the UI until the next reconcile, and failing a sync over it would be
		// worse than the thing it is reporting.
	}
}

export function readStatus(): FleetStatus {
	return status;
}

// ---------------------------------------------------------------------------
// Talking to one machine
// ---------------------------------------------------------------------------

/** One machine the hub reconciles: this one, or a reachable remote. */
interface Machine {
	name: string;
	/** undefined for this machine, which is reached in-process. */
	origin?: string;
}

async function machineList(tunnels: Tunnels): Promise<{ machines: Machine[]; hosts: PiwHostStatus[] }> {
	const hosts = await tunnels.status(listHosts());
	const machines: Machine[] = [{ name: LOCAL }];
	for (const h of hosts) {
		if (!h.reachable || h.foreign) continue;
		machines.push({ name: h.name, origin: h.url });
	}
	return { machines, hosts };
}

async function installedOn(m: Machine): Promise<packages.PiwPackage[]> {
	if (m.origin === undefined) return packages.list();
	const res = await fetch(`${m.origin}/api/packages`, {
		signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`/api/packages answered ${res.status}`);
	const body: unknown = await res.json();
	if (!isRecord(body) || !Array.isArray(body.packages)) throw new Error("no package list");
	return body.packages as packages.PiwPackage[];
}

async function installOn(m: Machine, source: string): Promise<{ ok: boolean; reason?: string; log: string }> {
	if (m.origin === undefined) return packages.install(source);
	const res = await fetch(`${m.origin}/api/packages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ source }),
		signal: AbortSignal.timeout(REMOTE_MUTATION_MS),
	});
	const body: unknown = await res.json().catch(() => null);
	if (!isRecord(body)) return { ok: false, reason: `install answered ${res.status}`, log: "" };
	return {
		ok: body.ok === true,
		...(typeof body.reason === "string" ? { reason: body.reason } : {}),
		log: typeof body.log === "string" ? body.log : "",
	};
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

/** One reconcile per machine at a time; machines run in parallel. */
const inFlight = new Set<string>();

/**
 * Bring one machine to the manifest.
 *
 * Installs what is missing and re-installs what is pinned differently —
 * `pi install <source>@<newpin>` moves a pin in place rather than adding a
 * second entry (verified on npm, and documented for git). It never removes:
 * a package here but not in the manifest is reported `unmanaged` and left
 * exactly where it is.
 */
async function reconcileMachine(m: Machine, manifest: Manifest): Promise<void> {
	if (inFlight.has(m.name)) return;
	inFlight.add(m.name);
	const at = new Date().toISOString();
	try {
		let present: packages.PiwPackage[];
		try {
			present = await installedOn(m);
		} catch (err) {
			status[m.name] = {
				reachable: false,
				at,
				error: err instanceof Error ? err.message : String(err),
				packages: status[m.name]?.packages ?? {},
			};
			persist();
			return;
		}

		const byIdentity = new Map(present.map((p) => [p.identity, p]));
		const next: Record<string, PackageState> = {};

		for (const entry of manifest.packages) {
			const want = packages.parseSource(entry.source);
			// A manifest entry that no longer parses is skipped rather than
			// reported per machine: it is one broken line, not one per box.
			if (!want || want.kind === "local") continue;

			if (entry.exclude?.includes(m.name)) {
				next[want.identity] = { state: "excluded" };
				continue;
			}

			const here = byIdentity.get(want.identity);
			byIdentity.delete(want.identity);
			if (here && here.pinned === want.pinned) {
				next[want.identity] = { state: "ok", version: here.installed };
				continue;
			}

			// Missing, or pinned to something else: the manifest's source is
			// what this machine should be running.
			status[m.name] = {
				reachable: true,
				at,
				packages: { ...(status[m.name]?.packages ?? {}), [want.identity]: { state: "installing" } },
			};
			const result = await installOn(m, entry.source);
			next[want.identity] = result.ok
				? { state: "ok", version: want.pinned }
				: { state: "failed", reason: result.reason ?? "install failed", log: result.log.slice(-2_000) };
		}

		// Whatever is left was not asked for. Reported, never removed.
		for (const [identity, p] of byIdentity) {
			if (p.kind === "local") continue;
			next[identity] = { state: "unmanaged", version: p.installed };
		}

		status[m.name] = { reachable: true, at, packages: next };
		persist();
	} finally {
		inFlight.delete(m.name);
	}
}

/**
 * Reconcile every reachable machine.
 *
 * A failure is contained to one machine and one package: the loop above
 * records it and moves on, and the next trigger retries. Machines run in
 * parallel because they are independent, and a slow npm on the orangepi must
 * not hold up the laptop.
 */
export async function reconcile(tunnels: Tunnels): Promise<FleetStatus> {
	const manifest = readManifest();
	const { machines, hosts } = await machineList(tunnels);
	recordUnreachable(hosts, machines);
	await Promise.all(machines.map((m) => reconcileMachine(m, manifest)));
	persist();
	return status;
}

/**
 * A machine we could not reach still has to appear, or "it is not in the
 * table" reads as "it has nothing to do". Its last known packages are kept:
 * what it had when it went away is still the most useful thing to show.
 */
function recordUnreachable(hosts: PiwHostStatus[], machines: Machine[]): void {
	const at = new Date().toISOString();
	for (const h of hosts) {
		if (machines.some((m) => m.name === h.name)) continue;
		status[h.name] = {
			reachable: false,
			at,
			error: h.foreign ? "not a pi-web-ide server" : "not answering",
			packages: status[h.name]?.packages ?? {},
		};
	}
}

/**
 * Watch for machines coming back, and reconcile them when they do.
 *
 * This is the whole point of a desired-state model: the orangepi that was
 * off when a package was added converges on its own, with nobody looking.
 * Only the transition triggers work — a machine that has been up all along
 * was reconciled when the manifest changed.
 */
export function watch(tunnels: Tunnels): () => void {
	let reachableBefore = new Set<string>();
	let stopped = false;

	const tick = async () => {
		if (stopped) return;
		try {
			const { machines, hosts } = await machineList(tunnels);
			// Recorded on every poll, not only when something changes: a machine
			// that has been down since before this server started must still
			// appear, or "it is not in the table" reads as "it is fine".
			recordUnreachable(hosts, machines);
			const now = new Set(machines.map((m) => m.name));
			const returned = [...now].filter((n) => !reachableBefore.has(n));
			reachableBefore = now;
			if (returned.length === 0) {
				persist();
				return;
			}
			const manifest = readManifest();
			await Promise.all(
				machines.filter((m) => returned.includes(m.name)).map((m) => reconcileMachine(m, manifest)),
			);
			persist();
		} catch {
			// A failed poll is not an event; the next one tries again.
		}
	};

	const timer = setInterval(() => void tick(), POLL_MS);
	timer.unref();
	// The first tick seeds `reachableBefore` AND converges this machine, which
	// is the one that is always up: a manifest edited by hand between two
	// server runs must not need a click to take effect.
	void tick();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

/**
 * Add an installed package to the manifest at the version it is running.
 *
 * "Adopt" is the answer to an unmanaged package: it is already here, it is
 * already working, and the only thing missing is the fleet agreeing about
 * it. An unpinned installation is adopted at the version on disk, which is
 * the only honest pin available.
 */
export function adopt(source: string, installed: string | null): Manifest {
	const parsed = packages.validate(source);
	let pinned = parsed.source;
	if (!parsed.pinned) {
		if (!installed) {
			throw new Error(`${parsed.identity} is not installed here, so there is no version to pin`);
		}
		pinned = `${parsed.source}@${installed}`;
	}
	const manifest = readManifest();
	return writeManifest({
		version: 1,
		packages: [...manifest.packages.filter((e) => e.source !== parsed.source), { source: pinned }],
	});
}
