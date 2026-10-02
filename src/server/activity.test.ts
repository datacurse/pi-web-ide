import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ACTIVITY_STATUS, parseActivity, type TurnActivity } from "../shared/activity.js";
import activityExtension from "./activity-extension.js";
import { ActivityTracker } from "./activity.js";

function harness(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pwi-activity-"));
	const previous = process.env.PWI_STATE_DIR;
	process.env.PWI_STATE_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PWI_STATE_DIR;
		else process.env.PWI_STATE_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
	const events: TurnActivity[] = [];
	const tracker = new ActivityTracker("session", (turn) => events.push(turn));
	const phase = (kind: string, at: number, extra = {}) => tracker.record({ type: "extension_ui_request", method: "setStatus", statusKey: ACTIVITY_STATUS, statusText: JSON.stringify({ kind, at, ...extra }) }, at);
	const delta = (type: string, at: number, text = "x") => tracker.record({ type: "message_update", assistantMessageEvent: { type, delta: text } }, at);
	return { tracker, events, phase, delta };
}

test("request, first response, first output and tool phases retain their measured durations", (t) => {
	const { tracker, events, phase, delta } = harness(t);
	tracker.record({ type: "message_start", message: { role: "user", timestamp: 1000 } }, 1000);
	phase("preparing", 1000);
	phase("request", 1020);
	phase("response", 1500);
	delta("thinking_delta", 4000);
	assert.equal(events.at(-1)?.lastOutputAt, 4000, "first output timestamp is immediately published even if the stream stalls");
	delta("text_delta", 6000);
	delta("toolcall_delta", 7000);
	tracker.record({ type: "message_end", message: { role: "assistant" } }, 7500);
	tracker.record({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "pnpm typecheck" } }, 7600);
	tracker.record({ type: "tool_execution_end", toolCallId: "a" }, 9600);
	phase("preparing", 9700);
	phase("request", 9720);
	phase("response", 10000);
	delta("text_delta", 12000);
	tracker.record({ type: "agent_settled" }, 13000);
	const turn = tracker.history[0];
	assert.equal(turn.asked, 1000);
	assert.equal(turn.end, 13000);
	assert.equal(turn.tools[0].label, "bash: pnpm typecheck");
	assert.equal(turn.tools[0].end! - turn.tools[0].start, 2000);
	const totals = turn.steps.reduce<Record<string, number>>((sum, step) => {
		sum[step.kind] = (sum[step.kind] ?? 0) + step.end! - step.start;
		return sum;
	}, {});
	assert.equal(totals.request, 760);
	assert.equal(totals.response, 4500);
	assert.equal(totals.tools, 2000);
	assert.equal(Object.values(totals).reduce((sum, ms) => sum + ms, 0), 12000);
	assert.deepEqual(parseActivity(turn), turn);
	assert.deepEqual(new ActivityTracker("session", () => {}).history, tracker.history, "completed timelines survive reopening");
});

test("parallel tool timings overlap without inflating wall-clock totals", (t) => {
	const { tracker } = harness(t);
	tracker.record({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a.ts" } }, 1000);
	tracker.record({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "git status" } }, 1500);
	tracker.record({ type: "tool_execution_end", toolCallId: "a" }, 3000);
	assert.match(tracker.history[0].steps.at(-1)!.label, /git status/);
	tracker.record({ type: "tool_execution_end", toolCallId: "b", isError: true }, 4500);
	tracker.finish(5000);
	const turn = tracker.history[0];
	assert.equal(turn.steps.filter((step) => step.kind === "tools").reduce((ms, step) => ms + step.end! - step.start, 0), 3500);
	assert.deepEqual(turn.tools.map((tool) => tool.end! - tool.start), [2000, 3000]);
	assert.equal(turn.tools[1].isError, true);
});

test("retry, compaction and user waits are explicit, and an unrelated tool end cannot hide a question", (t) => {
	const { tracker } = harness(t);
	tracker.record({ type: "auto_retry_start", attempt: 2, delayMs: 5000 }, 1000);
	assert.match(tracker.history[0].steps[0].label, /attempt 2.*5s backoff/);
	tracker.record({ type: "compaction_start" }, 2000);
	tracker.record({ type: "compaction_end" }, 4000);
	tracker.record({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" }, 5000);
	tracker.record({ type: "extension_ui_request", method: "confirm" }, 6000);
	tracker.record({ type: "tool_execution_end", toolCallId: "a" }, 7000);
	assert.equal(tracker.history[0].steps.at(-1)?.kind, "input");
	t.mock.method(Date, "now", () => 8000);
	tracker.resumeInput();
	assert.equal(tracker.history[0].steps.at(-1)?.kind, "processing");
	tracker.finish(9000);
	assert.equal(tracker.history[0].steps.filter((step) => step.kind === "input").reduce((ms, step) => ms + step.end! - step.start, 0), 2000);
});

test("activity heartbeats are throttled, malformed telemetry is ignored, and rewind discards old timings", (t) => {
	const { tracker, events, phase, delta } = harness(t);
	tracker.record({ type: "agent_start" }, 1000);
	phase("request", 1100);
	delta("text_delta", 2000);
	const published = events.length;
	for (let at = 2010; at < 3000; at += 10) delta("text_delta", at);
	assert.equal(events.length, published);
	delta("text_delta", 3000);
	assert.equal(events.length, published + 1);
	phase("invented", 4000);
	phase("response", -5);
	tracker.record({ type: "extension_ui_request", method: "setStatus", statusKey: ACTIVITY_STATUS, statusText: "not json" }, 4000);
	assert.equal(tracker.history[0].steps.at(-1)?.kind, "text");
	tracker.finish(5000);
	phase("request", 2000);
	assert.equal(tracker.history.length, 1, "replayed old telemetry does not start a new turn");
	tracker.rewind(1000);
	assert.deepEqual(new ActivityTracker("session", () => {}).history, []);
});

test("saved live activity can resume across server adoption and interrupted tools never claim success", (t) => {
	const { tracker } = harness(t);
	tracker.record({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" }, 1000);
	tracker.save();
	const resumed = new ActivityTracker("session", () => {});
	assert.equal(resumed.history[0].end, undefined);
	resumed.finish(3000);
	assert.equal(resumed.history[0].tools[0].end, 3000);
	assert.equal(resumed.history[0].tools[0].isError, undefined);
});

test("extension emits timestamps without copying provider payloads or credentials", (t) => {
	const handlers = new Map<string, (event: never, ctx: { isIdle(): boolean; ui: { setStatus(key: string, text: string): void } }) => void>();
	const signals: unknown[] = [];
	activityExtension({ on(event, handler) { handlers.set(event, handler); } });
	const ctx = { isIdle: () => false, ui: { setStatus(key: string, text: string) { assert.equal(key, ACTIVITY_STATUS); signals.push(JSON.parse(text)); } } };
	t.mock.method(Date, "now", () => 1234);
	for (const type of ["context", "before_provider_request", "before_provider_headers", "after_provider_response"]) {
		handlers.get(type)!({ status: 200, payload: "SECRET", headers: { authorization: "SECRET" } } as never, ctx);
	}
	assert.deepEqual(signals, [{ kind: "preparing", at: 1234 }, { kind: "request", at: 1234 }, { kind: "request", at: 1234 }, { kind: "response", at: 1234, status: 200 }]);
	handlers.get("before_provider_request")!({ payload: "SECRET" } as never, { ...ctx, isIdle: () => true });
	assert.equal(signals.length, 4, "idle cache-warming requests do not become conversation activity");
});
