/**
 * takeover.ts — claim the port from a previous piw.
 *
 * Restarting piw used to mean finding and killing the old process by hand:
 * the port is fixed, the old server holds it, and `pnpm dev` died with
 * "already in use". Every restart is a takeover — nobody starts a second piw
 * on the same port on purpose — so the server now does the killing itself.
 *
 * The safety property that makes that acceptable: it kills ONLY a process it
 * has positively identified as another pi-web-ide, by asking the port.
 * `/api/health` answers `{ ok: true, product: "pi-web-ide", cwd }`, and
 * nothing else on the machine does — in particular a server from the previous
 * install on a neighbouring port answers without `product` and is left alone,
 * and startup fails exactly as before. A coding agent's web UI must not be in
 * the business of killing whatever program happens to hold a port.
 */

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { connect } from "node:net";
import { PRODUCT } from "../shared/types.js";

/** How long the occupant gets to answer, exit politely, and then die. */
const PROBE_MS = 1_000;
const TERM_GRACE_MS = 5_000;
const KILL_GRACE_MS = 3_000;

interface Occupant {
	pid: number;
	cwd: string;
}

/**
 * Ask the port who it is.
 *
 * Only a pi-web-ide is ours to kill, and the proof is `product` in its
 * `/api/health`. An older piw answers `/api/health` with `{ ok, cwd }` and
 * no `product`, so it reads as a stranger and startup fails instead — which
 * is the whole point while both installs run side by side.
 *
 * A `pid` comes back from any build that has this file; older ones do not
 * report one, so it is resolved from /proc as a fallback.
 */
async function identify(port: number): Promise<Occupant | undefined> {
	let body: unknown;
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
			signal: AbortSignal.timeout(PROBE_MS),
		});
		if (!res.ok) return undefined;
		body = await res.json();
	} catch {
		// Not answering HTTP, or not answering in time: not identifiable, so
		// not ours to kill.
		return undefined;
	}

	if (typeof body !== "object" || body === null) return undefined;
	const health = body as { ok?: unknown; cwd?: unknown; pid?: unknown; product?: unknown };
	if (health.ok !== true || typeof health.cwd !== "string") return undefined;
	if (health.product !== PRODUCT) return undefined;

	const pid = typeof health.pid === "number" ? health.pid : listenerPid(port);
	return pid === undefined ? undefined : { pid, cwd: health.cwd };
}

/**
 * The pid listening on a loopback port, from /proc alone.
 *
 * `lsof`/`ss` are not installed everywhere and shelling out to find a pid we
 * are about to signal is a worse dependency than reading two files. Linux
 * only, which is the platform piw is deployed on; anywhere else this returns
 * undefined and the caller reports the port as held by a stranger.
 */
function listenerPid(port: number): number | undefined {
	const inodes = new Set<string>();
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text: string;
		try {
			text = readFileSync(table, "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n").slice(1)) {
			// sl local_address rem_address st … inode
			const cols = line.trim().split(/\s+/);
			const local = cols[1];
			const inode = cols[9];
			// 0A is TCP_LISTEN. A connected socket on the same port is somebody
			// talking TO the server, not the server.
			if (!local || cols[3] !== "0A" || !inode) continue;
			if (Number.parseInt(local.split(":")[1] ?? "", 16) !== port) continue;
			inodes.add(inode);
		}
	}
	if (inodes.size === 0) return undefined;

	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${entry}/fd`);
		} catch {
			// Another user's process, or one that exited mid-scan.
			continue;
		}
		for (const fd of fds) {
			let link: string;
			try {
				link = readlinkSync(`/proc/${entry}/fd/${fd}`);
			} catch {
				continue;
			}
			const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
			if (inode && inodes.has(inode)) return Number(entry);
		}
	}
	return undefined;
}

/** Is anything listening? A refused connection is the definition of free. */
function connectable(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = connect({ port, host: "127.0.0.1" });
	const done = (answer: boolean) => {
		socket.destroy();
		resolve(answer);
	};
	// A socket that connects but never settles still means "occupied".
	socket.setTimeout(PROBE_MS, () => done(true));
	socket.once("connect", () => done(true));
	socket.once("error", () => done(false));
	return promise;
}

async function waitForRelease(port: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	do {
		if (!(await connectable(port))) return true;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 100);
		await promise;
	} while (Date.now() < deadline);
	return !(await connectable(port));
}

/**
 * Make the port available, or explain why it is not.
 *
 * Returns once nothing is listening. Throws with a message meant for a
 * terminal when the occupant is not a piw, cannot be signalled, or refuses to
 * die — all cases where killing more aggressively would be guessing.
 */
export async function claimPort(port: number): Promise<void> {
	if (!(await connectable(port))) return;

	const occupant = await identify(port);
	if (!occupant) {
		throw new Error(
			`port ${port} is held by something that is not ${PRODUCT} — stop it or set PIW_PORT`,
		);
	}

	console.log(
		`[piw] port ${port} held by another ${PRODUCT} (pid ${occupant.pid}, cwd=${occupant.cwd}) — stopping it`,
	);
	try {
		process.kill(occupant.pid, "SIGTERM");
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new Error(`could not signal the server on port ${port} (pid ${occupant.pid}): ${reason}`);
	}

	if (await waitForRelease(port, TERM_GRACE_MS)) return;

	// SIGTERM is the polite path and it disposes sessions; a server wedged in
	// shutdown still has to let go of the port, and everything it owns is on
	// disk.
	console.log(`[piw] pid ${occupant.pid} did not exit in ${TERM_GRACE_MS / 1000}s — SIGKILL`);
	try {
		process.kill(occupant.pid, "SIGKILL");
	} catch {
		// Already gone between the two signals; the wait below settles it.
	}
	if (await waitForRelease(port, KILL_GRACE_MS)) return;

	throw new Error(`port ${port} is still held after SIGKILL of pid ${occupant.pid}`);
}
