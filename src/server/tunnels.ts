/**
 * tunnels.ts — piw owns the ssh forwards to the other machines.
 *
 * Why supervise rather than tell you to write a systemd unit: the tunnel is
 * disposable plumbing. The state worth protecting — the agent's process
 * memory, the credentials, the session on disk — is all on the remote, behind
 * the remote's own piw, so a forward that dies and comes back costs a
 * reconnect and never a turn. Owning a child process with capped backoff is
 * ~40 lines and works wherever ssh does; a per-machine unit file is a second
 * config surface to keep in sync with hosts.json, and it is Linux-only.
 *
 * `autostart: false` opts one host out, for a forward that should outlive piw.
 * Then this module only reports what the health probe sees.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { PRODUCT, type PiwHost, type PiwHostStatus, type PiwTunnelHost } from "../shared/types.js";

/** Same escape hatch as PIW_PI_BIN: a unit's PATH is not your shell's. */
const SSH_BIN = process.env.PIW_SSH_BIN ?? "ssh";

/**
 * Restart delays, then 30s forever. The long tail is deliberate: the common
 * reason a tunnel will not come up is that the machine is off, and retrying a
 * sleeping orangepi every second for an hour is just noise in the journal.
 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Uptime that proves the last spawn worked, so the next failure starts over. */
const STABLE_MS = 30_000;

/** Enough of ssh's stderr to carry the actual reason. */
const STDERR_KEEP = 400;

/** The remote gets this long to answer /api/health through the forward. */
const PROBE_MS = 1_500;

/** The state of OUR ssh child for a host; see PiwHostStatus.tunnel. */
type TunnelState = PiwHostStatus["tunnel"];

interface Tunnel {
	/** The spec this child was started with, to detect an edited host. */
	spec: string;
	child?: ChildProcess;
	retry?: NodeJS.Timeout;
	startedAt: number;
	attempt: number;
	state: TunnelState;
	error?: string;
}

function specOf(host: PiwTunnelHost): string {
	return `${host.ssh}|${host.port}|${host.remotePort}`;
}

/**
 * ssh, told to be a pipe and nothing else:
 *
 * - `-N -T`: no command, no tty. There is nothing to run on the remote.
 * - `BatchMode=yes`: piw has no terminal to answer a password or passphrase
 *   prompt on, and without this ssh would sit on stdin forever looking like a
 *   tunnel that is starting. It fails fast instead, and the reason reaches
 *   the UI. Key auth is therefore a requirement, which for a machine you
 *   already reach by ssh it already is.
 * - `ExitOnForwardFailure=yes`: a forward that did not bind must be an exit,
 *   not a live ssh with no listener behind it.
 * - `ServerAlive*`: a dropped link (laptop lid, changed network) is detected
 *   in ~45s and becomes an exit we can restart, instead of a hung socket.
 * - `StrictHostKeyChecking` is left alone on purpose. Accepting new keys
 *   automatically is a decision for your ssh config, not for a web UI.
 */
function argsFor(host: PiwTunnelHost): string[] {
	return [
		"-N",
		"-T",
		"-o",
		"BatchMode=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3",
		"-o",
		"ConnectTimeout=10",
		"-L",
		`${host.port}:127.0.0.1:${host.remotePort}`,
		host.ssh,
	];
}

export class Tunnels {
	readonly #tunnels = new Map<string, Tunnel>();
	#stopping = false;

	/**
	 * Make the running children match the stored list.
	 *
	 * Called on startup and after every edit, so it is written as a
	 * reconciliation rather than a set of add/remove hooks: the list is small,
	 * and "compare to the spec and fix the difference" cannot drift out of
	 * step with the file the way paired hooks can.
	 */
	sync(hosts: PiwHost[]): void {
		if (this.#stopping) return;
		// A direct host has nothing to forward; an unsupervised one is forwarded
		// by something else.
		const wanted = hosts.filter((h): h is PiwTunnelHost => "ssh" in h && h.autostart);
		for (const [name, tunnel] of this.#tunnels) {
			const host = wanted.find((h) => h.name === name);
			if (!host || specOf(host) !== tunnel.spec) {
				this.#kill(name);
			}
		}
		for (const host of wanted) {
			if (!this.#tunnels.has(host.name)) this.#spawn(host);
		}
	}

	/** Configuration plus live status, probing every host in parallel. */
	async status(hosts: PiwHost[]): Promise<PiwHostStatus[]> {
		return Promise.all(
			hosts.map(async (host) => {
				if (!("ssh" in host)) {
					const health = await probe(host.url);
					return { ...host, tunnel: "direct" as const, reachable: health !== undefined, ...health };
				}
				const tunnel = this.#tunnels.get(host.name);
				const health = await probe(`http://127.0.0.1:${host.port}`);
				return {
					...host,
					tunnel: tunnel?.state ?? "unsupervised",
					url: `http://127.0.0.1:${host.port}`,
					reachable: health !== undefined,
					...health,
					error: tunnel?.error,
				};
			}),
		);
	}

	/** Drop every child. Called from the signal handlers, so it cannot throw. */
	stop(): void {
		this.#stopping = true;
		for (const name of [...this.#tunnels.keys()]) this.#kill(name);
	}

	#spawn(host: PiwTunnelHost): void {
		const child = spawn(SSH_BIN, argsFor(host), {
			// No stdin: BatchMode already refuses to prompt, and an ignored stdin
			// means a confused ssh gets EOF rather than a pipe nobody writes to.
			stdio: ["ignore", "ignore", "pipe"],
		});
		const tunnel: Tunnel = {
			spec: specOf(host),
			child,
			startedAt: Date.now(),
			attempt: this.#tunnels.get(host.name)?.attempt ?? 0,
			state: "running",
		};
		this.#tunnels.set(host.name, tunnel);

		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-STDERR_KEEP);
		});
		// A failed spawn (no ssh on PATH) reports through 'error' and then
		// 'close', where there is no exit code to describe — so the message is
		// kept here and the retry happens below, like any other exit.
		let spawnError = "";
		child.on("error", (err) => {
			spawnError = err.message;
		});
		child.on("close", (code, signal) => {
			const current = this.#tunnels.get(host.name);
			if (current !== tunnel) return; // superseded by sync(); not ours to retry
			tunnel.child = undefined;
			// The exit is what happened; stderr only explains it. ssh is quiet on
			// success but not silent — a "Permanently added … to known hosts"
			// warning must not end up presented as the reason a tunnel died, so
			// the last stderr line annotates a bad exit rather than replacing it.
			const last = stderr
				.trim()
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean)
				.at(-1);
			tunnel.error = spawnError
				? spawnError
				: signal
					? `killed by ${signal}`
					: `exit ${code}${last ? `: ${last}` : ""}`;
			if (this.#stopping) return;
			this.#schedule(host, tunnel);
		});
	}

	#schedule(host: PiwTunnelHost, tunnel: Tunnel): void {
		// A forward that stood up for STABLE_MS did work, so the next outage is
		// a new outage and gets the short delay again. Without this, one flaky
		// night would leave every reconnect at the 30s cap.
		if (Date.now() - tunnel.startedAt >= STABLE_MS) tunnel.attempt = 0;
		const delay = BACKOFF_MS[Math.min(tunnel.attempt, BACKOFF_MS.length - 1)];
		tunnel.attempt++;
		tunnel.state = "backoff";
		tunnel.retry = setTimeout(() => {
			if (this.#stopping) return;
			if (this.#tunnels.get(host.name) !== tunnel) return;
			this.#spawn(host);
		}, delay);
		// The retry timer must not be what keeps node alive at shutdown.
		tunnel.retry.unref();
	}

	#kill(name: string): void {
		const tunnel = this.#tunnels.get(name);
		if (!tunnel) return;
		this.#tunnels.delete(name);
		clearTimeout(tunnel.retry);
		// SIGTERM is enough for ssh -N: it has nothing to flush, and the port is
		// released with the process. No grace-then-SIGKILL dance needed.
		tunnel.child?.kill("SIGTERM");
	}
}

/**
 * Ask an origin whether a pi-web-ide is behind it.
 *
 * Deliberately not takeover.ts's `identify`: that one falls back to /proc to
 * find a pid, which on this side of a tunnel would resolve the LOCAL ssh
 * client and report a remote that is not there. Here the only acceptable
 * evidence is the remote's own answer. Versions are passed through when the
 * remote reports them, so the page can show which host lags.
 */
async function probe(origin: string): Promise<
	| {
			remoteCwd: string;
			foreign: boolean;
			piwVersion?: string;
			piVersion?: string;
			hubOrigins?: boolean;
	  }
	| undefined
> {
	try {
		const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(PROBE_MS) });
		if (!res.ok) return undefined;
		const health: unknown = await res.json();
		if (typeof health !== "object" || health === null) return undefined;
		if (!("ok" in health) || health.ok !== true) return undefined;
		if (!("cwd" in health) || typeof health.cwd !== "string") return undefined;
		return {
			remoteCwd: health.cwd,
			// An older piw answers this endpoint too, and a forward pointed at
			// one would otherwise show up as a healthy member of the fleet.
			foreign: !("product" in health) || health.product !== PRODUCT,
			piwVersion:
				"piwVersion" in health && typeof health.piwVersion === "string" ? health.piwVersion : undefined,
			piVersion:
				"piVersion" in health && typeof health.piVersion === "string" ? health.piVersion : undefined,
			hubOrigins:
				"hubOrigins" in health && typeof health.hubOrigins === "boolean" ? health.hubOrigins : undefined,
		};
	} catch {
		// Refused, timed out, or not HTTP: not reachable, which is all the
		// caller needs. The reason a supervised tunnel is down is its stderr.
		return undefined;
	}
}
