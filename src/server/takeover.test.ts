// Run: node --import tsx src/server/takeover.test.ts
//
// The coexistence guard, which is the one bug in this project that kills
// something: the previous install's web UI answers `/api/health` too, and a
// takeover that trusted `{ ok: true }` alone would SIGTERM the server hosting
// the session that is building this one. So a fake occupant is stood up on a
// port, and the test asserts both halves: startup fails, and the occupant is
// still answering afterwards.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { claimPort } from "./takeover.js";
import { PRODUCT } from "../shared/types.js";

/** An HTTP server answering `/api/health` with `body`, on an ephemeral port. */
async function occupant(body: Record<string, unknown>): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		if (req.url !== "/api/health") {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address === "string" || address === null) throw new Error("no port");
	return {
		port: address.port,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function alive(port: number): Promise<boolean> {
	const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
		signal: AbortSignal.timeout(1000),
	}).catch(() => null);
	return res?.ok === true;
}

// A free port is claimed by doing nothing at all.
{
	const scratch = await occupant({ ok: true, product: PRODUCT, cwd: "/tmp", pid: process.pid });
	const port = scratch.port;
	await scratch.close();
	await claimPort(port);
}

// THE GUARD. An older piw answers `{ ok, cwd }` with no `product`: it is a
// stranger, startup fails, and it keeps running.
{
	const old = await occupant({ ok: true, cwd: "/home/loki/code/piw", pid: process.pid });
	try {
		await assert.rejects(() => claimPort(old.port), /is not pi-web-ide/);
		assert.equal(await alive(old.port), true, "the other product's server was left alone");
	} finally {
		await old.close();
	}
}

// Something that is not a web UI at all is equally not ours to kill.
{
	const stranger = await occupant({ hello: "postgres" });
	try {
		await assert.rejects(() => claimPort(stranger.port), /is not pi-web-ide/);
		assert.equal(await alive(stranger.port), true, "an unidentified occupant survives");
	} finally {
		await stranger.close();
	}
}

// A pi-web-ide IS ours to take the port from — but only because it said so.
// The pid here is this process, which must not be signalled, so the claim is
// expected to fail at the signal rather than at the identification: what is
// asserted is that it got past `identify` and tried.
{
	const mine = await occupant({ ok: true, product: PRODUCT, cwd: "/tmp", pid: 1 });
	try {
		await assert.rejects(() => claimPort(mine.port), /could not signal|still held/);
	} finally {
		await mine.close();
	}
}

console.log("ok");
