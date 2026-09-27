import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, matchAlias, parseStatus, validTarget } from "./fleet.js";

const status = JSON.stringify({
	Self: { HostName: "DESKTOP-X", DNSName: "desktop-x.tail.ts.net.", OS: "windows", TailscaleIPs: ["100.1.1.1", "fd7a::1"] },
	Peer: {
		a: { HostName: "roller", DNSName: "orangepi.tail.ts.net.", OS: "linux", TailscaleIPs: ["100.2.2.2"], Online: true, CurAddr: "192.168.3.81:41641", LastSeen: "0001-01-01T00:00:00Z" },
		b: { HostName: "Phone", DNSName: "phone.tail.ts.net.", OS: "android", TailscaleIPs: ["fd7a::3", "100.3.3.3"], Online: false, LastSeen: "2026-08-14T07:59:27Z" },
		c: { HostName: "loki-vps", DNSName: "loki-vps.tail.ts.net.", OS: "linux", TailscaleIPs: ["100.4.4.4"], Online: true, CurAddr: "88.214.24.214:41641" },
	},
});

test("self first, then peers by name; IPv4 preferred; last seen only when offline", () => {
	const peers = parseStatus(status);
	assert.deepEqual(peers.map((p) => p.name), ["desktop-x", "loki-vps", "orangepi", "phone"]);
	assert.equal(peers[0]?.self, true);
	assert.equal(peers[0]?.online, true);
	assert.equal(peers[2]?.dns, "orangepi.tail.ts.net");
	assert.equal(peers[3]?.ip, "100.3.3.3");
	assert.equal(peers[3]?.lastSeen, "2026-08-14T07:59:27Z");
	assert.equal(peers[2]?.lastSeen, undefined);
});

test("ssh alias matches by name, OS hostname, tailnet IP or current endpoint", () => {
	const [, vps, opi, phone] = parseStatus(status);
	const aliases = [
		{ alias: "tg", hostname: "88.214.24.214" },
		{ alias: "orangepi", hostname: "192.168.3.99" },
		{ alias: "pi2", hostname: "192.168.3.81" },
	];
	assert.equal(matchAlias(vps!, aliases), "tg");
	assert.equal(matchAlias(opi!, aliases), "orangepi");
	assert.equal(matchAlias(opi!, aliases.slice(2)), "pi2");
	assert.equal(matchAlias(opi!, [{ alias: "r", hostname: "ROLLER" }]), "r");
	assert.equal(matchAlias(phone!, aliases), undefined);
});

test("health answers", () => {
	assert.equal(classify(200, null), "running");
	assert.equal(classify(302, "http://127.0.0.1:5480/api/health"), "dev");
	assert.equal(classify(302, "https://example.com/"), "unserved");
	assert.equal(classify(502, null), "stopped");
	assert.equal(classify(404, null), "unserved");
});

test("ssh targets never become options", () => {
	assert.equal(validTarget("orangepi.tail.ts.net"), true);
	assert.equal(validTarget("root@tg"), true);
	assert.equal(validTarget("-oProxyCommand=x"), false);
	assert.equal(validTarget("a b"), false);
	assert.equal(validTarget(1), false);
});
