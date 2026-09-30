import assert from "node:assert/strict";
import { fatigue, pickNext } from "./rotation.ts";
import { WORKOUT_KINDS, type WorkoutSet } from "./types.ts";

const now = Date.parse("2025-01-01T12:00:00Z");
const ago = (min: number, kind: WorkoutSet["kind"]): WorkoutSet => ({
	at: new Date(now - min * 60_000).toISOString(),
	kind,
	amount: 10,
});

// Fatigue halves every 45 minutes.
assert.equal(fatigue([ago(0, "situps")], now).core, 1);
assert.equal(fatigue([ago(45, "situps")], now).core, 0.5);
assert.equal(fatigue([ago(0, "situps")], now).legs, 0);

// Right after pushups (chest, arms, core), a pure leg or calf exercise comes next, never an upper-body one.
for (let i = 0; i < 20; i++) {
	const next = pickNext([ago(1, "pushups")], [...WORKOUT_KINDS], now, () => i / 20)!;
	assert.ok(["squats", "lunges", "calfRaises", "wallSit"].includes(next), next);
}
// Legs just worked twice: upper body or calves, not legs.
const afterLegs = pickNext([ago(10, "squats"), ago(1, "wallSit")], ["squats", "lunges", "situps", "wallSit"], now, () => 0);
assert.equal(afterLegs, "situps");
// No repeat of the last one while another is on; alone, it repeats.
assert.equal(pickNext([ago(600, "plank")], ["plank", "situps"], now, () => 0), "situps");
assert.equal(pickNext([ago(1, "plank")], ["plank"], now), "plank");
assert.equal(pickNext([], [], now), null);
console.log("rotation: ok");

// Planning, in UTC so the working hours are plain.
process.env.TZ = "UTC";
const { plan } = await import("./rotation.ts");
const day = { every: 30, from: 9, to: 18 };
const at = (h: number, m = 0) => Date.parse(`2025-01-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
const kinds = [...WORKOUT_KINDS];

// Last set at 12:00: next due 12:30, then every 30 minutes until 18:00.
const p1 = plan([ago(0, "pushups")], kinds, day, now, 0, now);
assert.equal(p1[0]!.at, new Date(at(12, 30)).toISOString());
assert.equal(p1.at(-1)!.at, new Date(at(17, 30)).toISOString());
assert.equal(p1.length, 11);
// The same inputs give the same plan: it holds still between polls.
assert.deepEqual(plan([ago(0, "pushups")], kinds, day, now, 0, now), p1);
// Consecutive planned sets never repeat an exercise.
for (let i = 1; i < p1.length; i++) assert.notEqual(p1[i]!.kind, p1[i - 1]!.kind);
// A snooze past the due time moves the first set.
assert.equal(plan([], kinds, day, now, at(13), now)[0]!.at, new Date(at(13)).toISOString());
// Overdue: the first keeps its time, the rest count from now.
const late = plan([], kinds, day, at(10), 0, at(11));
assert.equal(late[0]!.at, new Date(at(10, 30)).toISOString());
assert.equal(late[1]!.at, new Date(at(11, 30)).toISOString());
// After hours: the next set is tomorrow at 9, and today's window is not continued.
const night = plan([], kinds, day, at(17, 50), 0, at(17, 55));
assert.equal(night[0]!.at, "2025-01-02T09:00:00.000Z");
// Nothing on, nothing planned.
assert.deepEqual(plan([], [], day, 0, 0, now), []);
console.log("plan: ok");
