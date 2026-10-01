import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as shared from "../shared/types.js";
import type { useSession } from "./useSession.js";

const source = ts.transpileModule(readFileSync(new URL("./useSession.ts", import.meta.url), "utf8"), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
const deferred = () => Promise.withResolvers<ReturnType<typeof response>>();

function harness() {
	const slots: unknown[] = [];
	let cursor = 0;
	const hooks = {
		useState(initial: unknown) {
			const at = cursor++;
			if (!(at in slots)) slots[at] = typeof initial === "function" ? initial() : initial;
			return [slots[at], (next: unknown) => {
				slots[at] = typeof next === "function" ? next(slots[at]) : next;
			}];
		},
		useRef(initial: unknown) {
			const at = cursor++;
			if (!(at in slots)) slots[at] = { current: initial };
			return slots[at];
		},
		useCallback: (callback: unknown) => callback,
		useEffect: () => {},
	};
	class Stream {
		static CLOSED = 2;
		onmessage?: (raw: { data: string }) => void;
		close() {}
		constructor() { streams.push(this); }
	}
	const streams: Stream[] = [];
	const requests = new Map<string, ReturnType<typeof deferred>>();
	let get = async (id: string) => response({ id, file: id });
	const api = { sessions: {
		open: { $post: async ({ json }: { json: { file?: string } }) => response({ id: json.file ?? "new", file: json.file ?? "new" }) },
		":id": {
			compact: { $post: ({ param }: { param: { id: string } }) => {
				const request = deferred();
				requests.set(param.id, request);
				return request.promise;
			} },
			$get: ({ param }: { param: { id: string } }) => get(param.id),
		},
	} };
	const exports = {} as { useSession: typeof useSession };
	runInNewContext(source, {
		exports, EventSource: Stream, setTimeout, clearTimeout,
		require: (name: string) => {
			switch (name) {
				case "react": return hooks;
				case "../shared/types.js": return shared;
				case "./api.js": return { api };
				case "./i18n.js": return { t: (text: string) => text };
				case "./GitActions.js": return { gitChanged: () => {} };
				case "./tabs.js": return {};
				default: throw new Error(`Unexpected import: ${name}`);
			}
		},
	});
	const env = {
		side: "left", project: "/project", scope: "/project",
		tabsRef: { current: { project: "other" } },
		commitTabs: () => {}, closeRef: { current: () => {} },
		refreshSessions: async () => {}, announce: () => {},
		opened: { current: new Set<string>() }, setPending: () => {},
	} as unknown as Parameters<typeof useSession>[0];
	return {
		render() { cursor = 0; return exports.useSession(env); },
		requests, streams,
		setGet(fn: typeof get) { get = fn; },
	};
}

for (const ok of [true, false]) {
	test(`compaction ${ok ? "success" : "failure"} stays in its original session`, async () => {
		const h = harness();
		await h.render().attach("old");
		const pending = h.render().compact();
		assert.equal(h.render().compacting, true);
		await h.render().attach();
		assert.equal(h.render().snapshot?.id, "new");
		assert.equal(h.render().compacting, false);
		h.requests.get("old")!.resolve(response({ error: "old failure" }, ok));
		await pending;
		assert.equal(h.render().snapshot?.id, "new");
		assert.equal(h.render().snapshot?.error, null);
	});
}

test("finishing old compaction does not stop a new session's compaction", async () => {
	const h = harness();
	await h.render().attach("old");
	const old = h.render().compact();
	await h.render().attach();
	const fresh = h.render().compact();
	h.requests.get("old")!.resolve(response({}));
	await old;
	assert.equal(h.render().compacting, true);
	h.requests.get("new")!.resolve(response({}));
	await fresh;
	assert.equal(h.render().compacting, false);
	assert.equal(h.render().snapshot?.id, "new");
});

test("returning to a compacting session restores its loading state", async () => {
	const h = harness();
	await h.render().attach("old");
	const pending = h.render().compact();
	await h.render().attach();
	assert.equal(h.render().compacting, false);
	await h.render().attach("old");
	assert.equal(h.render().compacting, true);
	h.requests.get("old")!.resolve(response({}));
	await pending;
	assert.equal(h.render().compacting, false);
});

test("an old event-stream refresh cannot overwrite the new session", async () => {
	const h = harness();
	await h.render().attach("old");
	const pending = deferred();
	h.setGet(() => pending.promise);
	const oldStream = h.streams[0]!;
	oldStream.onmessage!({ data: JSON.stringify({ type: "message_done" }) });
	await h.render().attach();
	pending.resolve(response({ id: "old", file: "old" }));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.render().snapshot?.id, "new");
	oldStream.onmessage!({ data: JSON.stringify({ type: "error", message: "old error" }) });
	assert.equal(h.render().snapshot?.error, null);
});
