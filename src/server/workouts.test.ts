import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkout, isWorkoutKind, readWorkouts } from "./workouts.ts";

const dir = mkdtempSync(join(tmpdir(), "pwi-workouts-"));
process.env.PWI_STATE_DIR = dir;

assert.deepEqual(readWorkouts(), []);
// A set logged before timed exercises existed still reads.
writeFileSync(join(dir, "workouts.json"), JSON.stringify([{ at: "2025-01-01T09:00:00.000Z", kind: "situps", reps: 10 }]));
addWorkout("pushups", new Date("2025-01-01T10:00:00Z"));
addWorkout("plank", new Date("2025-01-01T11:00:00Z"));
assert.deepEqual(readWorkouts(), [
	{ at: "2025-01-01T09:00:00.000Z", kind: "situps", amount: 10 },
	{ at: "2025-01-01T10:00:00.000Z", kind: "pushups", amount: 10 },
	{ at: "2025-01-01T11:00:00.000Z", kind: "plank", amount: 20 },
]);
assert.equal(isWorkoutKind("wallSit"), true);
assert.equal(isWorkoutKind("squat"), false);
assert.equal(isWorkoutKind("toString"), false);
console.log("workouts: ok");

// Which exercises are on lives beside the Workout switch.
const { pwiExtensions, writeWorkoutOff } = await import("./pwiExtensions.ts");
assert.deepEqual(pwiExtensions().workoutOff, []);
assert.deepEqual(writeWorkoutOff(["plank", "burpees", "plank"])?.workoutOff, ["plank", "burpees"]);
assert.equal(writeWorkoutOff(["squat"]), null);
assert.equal(writeWorkoutOff(Object.keys((await import("../shared/types.ts")).EXERCISES)), null);
assert.deepEqual(pwiExtensions().workoutOff, ["plank", "burpees"]);
console.log("workout exercises: ok");
