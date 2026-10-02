import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { devEnvironment, serverBoot, waitForServer } from "./dev.mjs";

test("dev serves the stable build on 8890 and preserves explicit overrides", () => {
	assert.deepEqual(devEnvironment({}), { PWI_PORT: "8890", PWI_TAKEOVER: "0" });
	assert.deepEqual(devEnvironment({ PWI_PORT: "9000", PWI_TAKEOVER: "1", OTHER: "kept" }), {
		PWI_PORT: "9000", PWI_TAKEOVER: "1", OTHER: "kept",
	});
});

test("readiness ignores the old boot, outages, and foreign services", async (t) => {
	let body = { ok: true, product: "pi-web-ide", boot: "old" };
	const server = createServer((req, res) => {
		assert.equal(req.url, "/api/health");
		if (body === null) { res.writeHead(503).end(); return; }
		res.setHeader("Content-Type", "application/json");
		res.end(JSON.stringify(body));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const port = server.address().port;
	assert.equal(await serverBoot(port), "old");
	await assert.rejects(waitForServer(port, "old", 150), /did not become ready/);
	body = null;
	assert.equal(await serverBoot(port), undefined);
	body = { ok: true, product: "another-app", boot: "new" };
	assert.equal(await serverBoot(port), undefined);
	body = { ok: true, product: "pi-web-ide" };
	assert.equal(await serverBoot(port), undefined);
	body = { ok: true, product: "pi-web-ide", boot: "new" };
	await waitForServer(port, "old", 150);
	await waitForServer(port, undefined, 150);
});
