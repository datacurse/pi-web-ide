// Run: node --import tsx src/server/hosts.test.ts
import { addHost, listHosts, removeHost } from "./hosts.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The machine list is written under PIW_STATE_DIR, so the test gets its own
// and never rewrites the developer's real one.
process.env.PIW_STATE_DIR = mkdtempSync(join(tmpdir(), "piw-hosts-"));

const PORT = 8890;
const before = listHosts();
assert(!before.some((h) => h.name.startsWith("piw-test")), "test hosts must not pre-exist");

// ssh takes its destination positionally, so a leading dash is an option we
// did not write — `-oProxyCommand=…` being the one that matters.
assert.throws(() => addHost({ ssh: "-oProxyCommand=id" }, PORT), /not an ssh destination/);
assert.throws(() => addHost({ ssh: "host name" }, PORT), /not an ssh destination/);
assert.throws(() => addHost({}, PORT), /required/);

// Forwarding our own port could only ever produce a tunnel that cannot bind.
assert.throws(() => addHost({ ssh: "piw-test", port: PORT }, PORT), /already in use/);
assert.throws(() => addHost({ ssh: "piw-test", port: 80 }, PORT), /1024-65535/);

const added = addHost({ ssh: "piw-test" }, PORT);
const host = added.find((h) => h.name === "piw-test");
assert(host && "ssh" in host, "added as a tunnel host");
assert(host.port > PORT, "auto-assigned port is above ours");
assert.equal(host.remotePort, 8890, "remote piw default");
assert.equal(host.autostart, true, "piw owns the tunnel by default");

// The name is the identity the UI addresses, so a second one must not slip in.
assert.throws(() => addHost({ ssh: "piw-test" }, PORT), /already added/);
// Two machines cannot share a local port: the second ssh would fail to bind.
assert.throws(() => addHost({ ssh: "piw-test2", port: host.port }, PORT), /already in use/);

const second = addHost({ ssh: "piw-test2", autostart: false }, PORT);
const secondHost = second.at(-1);
assert(secondHost && "ssh" in secondHost, "added as a tunnel host");
assert.notEqual(secondHost.port, host.port, "each machine gets its own port");
assert.equal(secondHost.autostart, false, "autostart opt-out is kept");

// A direct host is an origin and nothing else: the page appends /api/… to it,
// so a path, query or credentials would be silently dropped or, worse, kept.
assert.throws(() => addHost({ url: "opi.tail.ts.net" }, PORT), /not a url/);
assert.throws(() => addHost({ url: "ftp://opi.tail.ts.net" }, PORT), /http\(s\)/);
assert.throws(() => addHost({ url: "https://opi.tail.ts.net/piw" }, PORT), /origin only/);
assert.throws(() => addHost({ url: "https://u:p@opi.tail.ts.net" }, PORT), /origin only/);

const direct = addHost({ name: "piw-test3", url: "https://opi.tail.ts.net/" }, PORT).at(-1);
assert(direct && !("ssh" in direct), "added as a direct host");
assert.equal(direct.url, "https://opi.tail.ts.net", "stored as a bare origin");
// A direct host holds no loopback port, so it must not shadow one for a tunnel.
const third = addHost({ ssh: "piw-test4" }, PORT).at(-1);
assert(third && "ssh" in third && third.port === secondHost.port + 1, "ports skip only tunnels");

// Round-trips through the file as the same kind.
const reread = listHosts().find((h) => h.name === "piw-test3");
assert(reread && !("ssh" in reread) && reread.url === direct.url, "direct host survives reload");

for (const name of ["piw-test", "piw-test2", "piw-test3", "piw-test4"]) removeHost(name);
assert.deepEqual(listHosts(), before, "restored");
console.log("ok");
