/**
 * workouts.ts — the sets done for the workout gate (web/Workout.tsx), one
 * entry per Done, for the Workouts tab in Stats.
 */

import { EXERCISES, type WorkoutKind, type WorkoutSet } from "../shared/types.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const FILE = "workouts.json";

/** This machine's sets, or another's from its mirror (machines.ts). */
export function readWorkouts(file = statePath(FILE)): WorkoutSet[] {
	try {
		const all = JSON.parse(readStateFile(file) ?? "[]");
		if (!Array.isArray(all)) return [];
		// The first sets were logged as `reps` before timed exercises existed.
		return all.map((s) => ({ at: s.at, kind: s.kind, amount: s.amount ?? s.reps }));
	} catch {
		return [];
	}
}

export function isWorkoutKind(kind: unknown): kind is WorkoutKind {
	return typeof kind === "string" && Object.hasOwn(EXERCISES, kind);
}

export function addWorkout(kind: WorkoutKind, at = new Date()): WorkoutSet {
	const set = { at: at.toISOString(), kind, amount: EXERCISES[kind].amount };
	writeStateFile(statePath(FILE), `${JSON.stringify([...readWorkouts(), set])}\n`);
	return set;
}
