/**
 * machines.ts — other machines' pi sessions, for Stats.
 *
 * Every concrete `Host` in ~/.ssh/config is probed over ssh; one that answers
 * and has a pi session store is mirrored with rsync into the state dir. pi only
 * appends to session files, so a sync moves only the new lines. Aliases of one
 * machine share one mirror, named after the first alias in the config. A
 * machine is its /etc/machine-id AND hostname: VPSes cloned from one image
 * share the id. A machine that is off keeps its last mirror.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const run = promisify(execFile);
/** Never prompt, never hang: a host that needs a password or is off is skipped. */
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2"];
const INDEX = "machines.json";
/** Stats reloads after every reply; this keeps that from ssh-ing each time. */
const THROTTLE_MS = 30_000;

export interface Machine {
	/** The first ssh alias for it, in config order. */
	name: string;
	/** The mirror of its `~/.pi/agent/sessions`. */
	root: string;
	/** When its mirror last synced, ISO. */
	synced: string;
	/** Why the last sync did not reach it. */
	error?: string;
}

interface Index {
	/** ssh alias → machine id, as last seen. */
	hosts: Record<string, string>;
	/** machine id → last successful sync, ISO. */
	synced: Record<string, string>;
}

/** Concrete host aliases in an ssh config, in order; wildcards and negations are patterns, not machines. */
export function parseSshHosts(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*host(?:\s*=\s*|\s+)(.+)$/i.exec(line);
		for (const h of m?.[1]?.trim().split(/\s+/) ?? [])
			if (!/[*?!]/.test(h) && !out.includes(h)) out.push(h);
	}
	return out;
}

export function sshHosts(): string[] {
	try {
		return parseSshHosts(readFileSync(join(homedir(), ".ssh", "config"), "utf8"));
	} catch {
		return [];
	}
}

function readIndex(): Index {
	try {
		const raw = JSON.parse(readStateFile(statePath(INDEX)) ?? "") as Partial<Index>;
		return { hosts: raw.hosts ?? {}, synced: raw.synced ?? {} };
	} catch {
		return { hosts: {}, synced: {} };
	}
}

const mirror = (id: string) => join(statePath("machines"), id.replace(/[^\w.-]/g, "_"));

function localId(): string {
	let id = "";
	try {
		id = readFileSync("/etc/machine-id", "utf8").trim();
	} catch {
		// Not Linux: the hostname alone.
	}
	return `${id}-${hostname()}`;
}

/** The last line ssh or rsync wrote to stderr, which is the one that says why. */
function reason(err: unknown): string {
	const stderr = (err as { stderr?: string }).stderr?.trim().split("\n").pop();
	return stderr || (err instanceof Error ? err.message : String(err));
}

async function probe(host: string): Promise<{ id: string; pi: boolean }> {
	const { stdout } = await run(
		"ssh",
		[...SSH, host, 'echo "$(cat /etc/machine-id 2>/dev/null)-$(hostname)"; test -d .pi/agent/sessions && echo pi'],
		{ timeout: 15_000 },
	);
	const lines = stdout.split("\n").map((l) => l.trim());
	return { id: lines[0] ?? "", pi: lines.includes("pi") };
}

async function rsync(host: string, dest: string): Promise<void> {
	mkdirSync(dest, { recursive: true });
	await run(
		"rsync",
		[
			"-a",
			"--delete",
			"--append-verify",
			"--include=*/",
			"--include=*.jsonl",
			"--exclude=*",
			"-e",
			`ssh ${SSH.join(" ")}`,
			`${host}:.pi/agent/sessions/`,
			`${dest}/`,
		],
		{ timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
	);
}

const errors = new Map<string, string>();
let running: Promise<void> | undefined;
let last = 0;

/** Bring every mirror up to date. Concurrent calls share one run; `force` skips the throttle. */
export function syncMachines(force = false): Promise<void> {
	if (running) return running;
	if (!force && Date.now() - last < THROTTLE_MS) return Promise.resolve();
	running = sync().finally(() => {
		last = Date.now();
		running = undefined;
	});
	return running;
}

async function sync(): Promise<void> {
	const index = readIndex();
	const self = localId();
	const probes = await Promise.all(
		sshHosts().map(async (host) => {
			try {
				return { host, ...(await probe(host)) };
			} catch (err) {
				return { host, id: "", pi: false, error: reason(err) };
			}
		}),
	);
	for (const p of probes) if (p.id) index.hosts[p.host] = p.id;

	// One alias per machine: the first reachable one, in config order.
	const reached = new Set<string>();
	const jobs = probes.filter((p) => {
		if (!p.id || !p.pi || p.id === self || reached.has(p.id)) return false;
		reached.add(p.id);
		return true;
	});
	errors.clear();
	await Promise.all(
		jobs.map((p) =>
			rsync(p.host, mirror(p.id)).then(
				() => {
					index.synced[p.id] = new Date().toISOString();
				},
				(err: unknown) => {
					errors.set(p.id, reason(err));
				},
			),
		),
	);
	// A known machine no alias reached this time: say why on its button.
	for (const p of probes) {
		const id = index.hosts[p.host];
		const error = "error" in p ? p.error : undefined;
		if (error && id && !reached.has(id) && !errors.has(id)) errors.set(id, error);
	}
	writeStateFile(statePath(INDEX), JSON.stringify(index));
}

/** Machines with a mirror, one per machine, in ssh config order. */
export function machines(): Machine[] {
	const index = readIndex();
	const seen = new Set<string>();
	const out: Machine[] = [];
	for (const host of sshHosts()) {
		const id = index.hosts[host];
		const synced = id && index.synced[id];
		if (!id || !synced || seen.has(id)) continue;
		seen.add(id);
		out.push({ name: host, root: mirror(id), synced, error: errors.get(id) });
	}
	return out;
}
