/**
 * hosts.ts — the other machines you can reach from this piw.
 *
 * A host is either an ssh destination plus the loopback port on THIS machine
 * that forwards to the piw running over there, or an origin the browser can
 * open directly (a tailnet name behind `tailscale serve`). That is the whole
 * model: piw does not proxy the agent, does not hold remote credentials and
 * does not know anything about the remote's projects. The page talks to each
 * machine's piw at that machine's own origin.
 *
 * The store is a flat JSON array in this server's own state directory, for
 * the same reason projects.ts uses one: this list is the only new persistent
 * state in the feature, and a file the user can read and edit by hand is a
 * feature. It is NOT inherited from the previous install: those entries name
 * forward ports that server still owns, pointing at remotes where an older
 * piw is listening.
 */

import { readFileSync } from "node:fs";
import { statePath, writeStateFile } from "./state.js";
import type { PiwHost, PiwTunnelHost } from "../shared/types.js";

/** What a remote piw listens on, absent a reason to think otherwise. */
const DEFAULT_REMOTE_PORT = 8890;

/** A label has to fit a 288px panel and name a browser window; 32 is plenty. */
const MAX_NAME = 32;

/**
 * `autostart: false` is for a forward that should outlive piw — a systemd
 * unit on an always-on box. piw then only reports whether the remote answers
 * through it.
 */
export function listHosts(): PiwHost[] {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(statePath("hosts.json"), "utf8"));
	} catch {
		// Missing or corrupt file means "no machines yet", which is the normal
		// state of a fresh install and not an error.
		return [];
	}
	if (!Array.isArray(raw)) return [];
	// Drop what does not parse rather than throwing: a hand-edited file with
	// one bad entry must not take the whole list — and the list is what the
	// UI needs to offer a fix.
	return raw.map(coerce).filter((h): h is PiwHost => h !== undefined);
}

/**
 * Add a machine: `{ url }` for one reachable directly, `{ ssh }` for one
 * behind a forward. Both, and the url wins — a machine on the tailnet needs
 * no tunnel, and keeping one would only bind a port for nothing.
 *
 * `reservedPort` is the port this piw itself listens on. Forwarding it would
 * either fail to bind or, worse, get taken by a restarting piw's port claim —
 * so it is rejected here instead of becoming a confusing tunnel that dies.
 */
export function addHost(input: unknown, reservedPort: number): PiwHost[] {
	const raw = (input ?? {}) as Record<string, unknown>;
	const hosts = listHosts();

	if (typeof raw.url === "string" && raw.url.trim()) {
		const url = origin(raw.url);
		const name = hostName(raw.name, new URL(url).hostname);
		if (hosts.some((h) => h.name === name)) throw new Error(`already added: ${name}`);
		const next = [...hosts, { name, url }];
		save(next);
		return next;
	}

	const ssh = sshDestination(raw.ssh);
	const name = hostName(raw.name, ssh);
	const remotePort = port(raw.remotePort, DEFAULT_REMOTE_PORT, "remotePort");
	const autostart = raw.autostart === undefined ? true : raw.autostart === true;

	if (hosts.some((h) => h.name === name)) throw new Error(`already added: ${name}`);

	// Direct hosts occupy no loopback port, so only the forwards count.
	const taken = new Set([
		reservedPort,
		...hosts.filter((h): h is PiwTunnelHost => "ssh" in h).map((h) => h.port),
	]);
	const local =
		raw.port === undefined
			? freePort(reservedPort + 1, taken)
			: port(raw.port, 0, "port");
	if (taken.has(local)) throw new Error(`port already in use by piw: ${local}`);

	const next = [...hosts, { name, ssh, port: local, remotePort, autostart }];
	save(next);
	return next;
}

/**
 * The origin and nothing else. A path would be silently ignored by every
 * `${url}/api/…` the page builds, and http is allowed only because a
 * loopback forward managed outside piw is still a valid way to reach a host.
 */
function origin(value: string): string {
	let u: URL;
	try {
		u = new URL(value.trim());
	} catch {
		throw new Error(`not a url: ${value}`);
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") {
		throw new Error(`url must be http(s): ${value}`);
	}
	if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) {
		throw new Error(`url must be an origin only, like https://host or http://127.0.0.1:8791: ${value}`);
	}
	return u.origin;
}

/** Forget a machine. Nothing on the remote is touched; the tunnel is dropped. */
export function removeHost(name: string): PiwHost[] {
	const next = listHosts().filter((h) => h.name !== name);
	save(next);
	return next;
}

/**
 * ssh takes its destination positionally, so a value starting with `-` would
 * be read as an option — `-oProxyCommand=…` is the interesting one. There is
 * no shell involved (we spawn ssh directly), so nothing else here is about
 * quoting: it is about not handing ssh flags we did not write.
 */
function sshDestination(value: unknown): string {
	const ssh = typeof value === "string" ? value.trim() : "";
	if (!ssh) throw new Error("ssh destination or url required");
	if (ssh.startsWith("-")) throw new Error(`not an ssh destination: ${ssh}`);
	if (/[\s\u0000-\u001f]/.test(ssh)) throw new Error(`not an ssh destination: ${ssh}`);
	return ssh;
}

function hostName(value: unknown, fallback: string): string {
	const name = (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(
		0,
		MAX_NAME,
	);
	if (/[\u0000-\u001f]/.test(name)) throw new Error("invalid name");
	return name;
}

function port(value: unknown, fallback: number, field: string): number {
	if (value === undefined && fallback) return fallback;
	const n = typeof value === "number" ? value : Number(value);
	// 1024 rather than 1: binding below it needs privileges piw does not have
	// and should never be given.
	if (!Number.isInteger(n) || n < 1024 || n > 65535) {
		throw new Error(`${field} must be an integer in 1024-65535`);
	}
	return n;
}

function freePort(from: number, taken: Set<number>): number {
	let p = from;
	while (taken.has(p)) p++;
	if (p > 65535) throw new Error("no free port");
	return p;
}

/** One stored entry, or undefined if it is not usable as a host. */
function coerce(raw: unknown): PiwHost | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const h = raw as Record<string, unknown>;
	if (typeof h.url === "string" && h.url.trim()) {
		try {
			const url = origin(h.url);
			return {
				name: typeof h.name === "string" && h.name.trim() ? h.name.trim() : new URL(url).hostname,
				url,
			};
		} catch {
			return undefined;
		}
	}
	if (typeof h.ssh !== "string" || !h.ssh.trim() || h.ssh.startsWith("-")) return undefined;
	if (typeof h.port !== "number" || !Number.isInteger(h.port)) return undefined;
	const remotePort =
		typeof h.remotePort === "number" && Number.isInteger(h.remotePort)
			? h.remotePort
			: DEFAULT_REMOTE_PORT;
	return {
		name: typeof h.name === "string" && h.name.trim() ? h.name.trim() : h.ssh.trim(),
		ssh: h.ssh.trim(),
		port: h.port,
		remotePort,
		autostart: h.autostart !== false,
	};
}

function save(hosts: PiwHost[]): void {
	writeStateFile(statePath("hosts.json"), JSON.stringify(hosts, null, "\t"), 0o644);
}
