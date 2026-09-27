/**
 * fleet.ts — every machine on the tailnet, its pwi link and how to reach it.
 *
 * The list is `tailscale status`, so a machine shows up by joining the tailnet,
 * with no config here. Each one is paired with the ~/.ssh/config alias that
 * reaches it (the user and key live there); without one, ssh gets the MagicDNS
 * name and asks. pwi binds loopback only, so its tailnet link exists only
 * where `tailscale serve` forwards the port: Start sets that up too.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FleetMachine, FleetPwi } from "../shared/types.js";
import { sshHosts } from "./machines.js";

const run = promisify(execFile);
/** The port pwi and its `tailscale serve` use on every machine: the default. */
const PWI_PORT = 8890;
const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];

interface TsNode {
	HostName?: string;
	DNSName?: string;
	OS?: string;
	TailscaleIPs?: string[] | null;
	Online?: boolean;
	LastSeen?: string;
	CurAddr?: string;
}

/** A tailnet node plus what its ssh alias can be matched against. */
export interface Peer extends Omit<FleetMachine, "ssh" | "url" | "pwi"> {
	/** Lowercase names and addresses an ssh `HostName` might use for it. */
	addresses: string[];
}

/** `host:port` or `[v6]:port` → host. */
const hostOf = (addr: string) => addr.replace(/^\[(.*)\]:\d+$/, "$1").replace(/:\d+$/, "");

function peer(n: TsNode, self: boolean): Peer {
	const dns = (n.DNSName ?? "").replace(/\.$/, "");
	const name = dns.split(".")[0] || (n.HostName ?? "").toLowerCase();
	const ips = n.TailscaleIPs ?? [];
	const ip = ips.find((a) => !a.includes(":")) ?? ips[0] ?? "";
	const seen = n.LastSeen && !n.LastSeen.startsWith("0001") ? n.LastSeen : undefined;
	return {
		name,
		dns: dns || name,
		ip,
		os: n.OS ?? "",
		online: self || n.Online === true,
		self,
		lastSeen: self || n.Online ? undefined : seen,
		addresses: [name, dns, n.HostName ?? "", ...ips, n.CurAddr ? hostOf(n.CurAddr) : ""]
			.filter(Boolean)
			.map((a) => a.toLowerCase()),
	};
}

/** `tailscale status --json` → this machine first, then the peers by name. */
export function parseStatus(json: string): Peer[] {
	let s: { Self?: TsNode; Peer?: Record<string, TsNode> | null };
	try {
		s = JSON.parse(json) as typeof s;
	} catch {
		throw new Error("tailscale status did not print JSON");
	}
	const peers = Object.values(s.Peer ?? {})
		.map((n) => peer(n, false))
		.sort((a, b) => a.name.localeCompare(b.name));
	return s.Self ? [peer(s.Self, true), ...peers] : peers;
}

/** The first alias (config order) named after the machine or pointing at one of its addresses. */
export function matchAlias(p: Peer, aliases: { alias: string; hostname: string }[]): string | undefined {
	return aliases.find(
		(a) => a.alias.toLowerCase() === p.name || p.addresses.includes(a.hostname.toLowerCase()),
	)?.alias;
}

/** What the tailnet link answered. `location` is the redirect target, if any. */
export function classify(status: number, location: string | null): FleetPwi {
	if (status >= 200 && status < 300) return "running";
	if (status >= 300 && status < 400 && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(location ?? "")) return "dev";
	if (status === 502 || status === 503 || status === 504) return "stopped";
	return "unserved";
}

/** WSL has no `tailscale`, only the Windows client's `tailscale.exe` through interop. */
async function tailscale(args: string[]): Promise<string> {
	try {
		return (await run("tailscale", args, { timeout: 10_000 })).stdout;
	} catch (err) {
		// EACCES: a non-executable `tailscale` earlier on PATH, as WSL can have.
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "EACCES") throw err;
		return (await run("tailscale.exe", args, { timeout: 10_000 })).stdout;
	}
}

/** `ssh -G` resolves each alias the way ssh will, including Match and Include. */
async function aliases(): Promise<{ alias: string; hostname: string }[]> {
	return Promise.all(
		sshHosts().map(async (alias) => {
			const { stdout } = await run("ssh", ["-G", alias], { timeout: 5_000 }).catch(() => ({ stdout: "" }));
			return { alias, hostname: /^hostname (.+)$/m.exec(stdout)?.[1]?.trim() ?? "" };
		}),
	);
}

async function probe(url: string): Promise<FleetPwi> {
	try {
		const r = await fetch(`${url}api/health`, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
		return classify(r.status, r.headers.get("location"));
	} catch {
		return "unserved";
	}
}

export async function fleet(): Promise<FleetMachine[]> {
	const [peers, known] = await Promise.all([tailscale(["status", "--json"]).then(parseStatus), aliases()]);
	return Promise.all(
		peers.map(async (p): Promise<FleetMachine> => {
			const { addresses: _, ...machine } = p;
			const url = `http://${p.dns}:${PWI_PORT}/`;
			const ssh = matchAlias(p, known) ?? p.dns;
			return { ...machine, ssh, url, pwi: p.online ? await probe(url) : undefined };
		}),
	);
}

/** An ssh destination we pass on: an alias or a DNS name, never an option. */
export const validTarget = (t: unknown): t is string => typeof t === "string" && /^[\w.@-]+$/.test(t) && !t.startsWith("-");

/**
 * Start pwi's user unit on `target`, then make sure `tailscale serve` forwards
 * its port: without that the machine runs pwi that no link reaches.
 */
export async function startPwi(target: string): Promise<void> {
	const serve = `tailscale serve --bg --http=${PWI_PORT} http://127.0.0.1:${PWI_PORT}`;
	const script = `systemctl --user start pi-web-ide && { tailscale serve status 2>/dev/null | grep -q ':${PWI_PORT}' || ${serve}; }`;
	try {
		await run("ssh", [...SSH, target, script], { timeout: 30_000 });
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr
			?.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !/post-quantum|store now|pq\.html|upgraded/.test(l))
			.pop();
		throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
	}
}
