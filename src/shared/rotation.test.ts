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
