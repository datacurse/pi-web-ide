import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSshHosts } from "./machines.js";

test("concrete Host aliases in order, patterns and HostName skipped", () => {
	const config = [
		"Host tg",
		"  HostName 10.0.0.2",
		"host orangepi opi",
		"Host=papershub",
		"Host *.internal !bastion gw?",
		"Host tg",
		"Match all",
	].join("\n");
	assert.deepEqual(parseSshHosts(config), ["tg", "orangepi", "opi", "papershub"]);
});
