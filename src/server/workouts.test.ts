import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkout, isWorkoutKind, readWorkouts } from "./workouts.ts";

process.env.PWI_STATE_DIR = mkdtempSync(join(tmpdir(), "pwi-workouts-"));

assert.deepEqual(readWorkouts(), []);
addWorkout("pushups", new Date("2025-01-01T10:00:00Z"));
addWorkout("situps", new Date("2025-01-01T11:00:00Z"));
assert.deepEqual(readWorkouts(), [
	{ at: "2025-01-01T10:00:00.000Z", kind: "pushups", reps: 10 },
	{ at: "2025-01-01T11:00:00.000Z", kind: "situps", reps: 10 },
]);
assert.equal(isWorkoutKind("situps"), true);
assert.equal(isWorkoutKind("squats"), false);
console.log("workouts: ok");
