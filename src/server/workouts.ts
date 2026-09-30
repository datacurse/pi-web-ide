/**
 * workouts.ts — the sets done for the workout gate (web/Workout.tsx), one
 * entry per Done, for the Workouts tab in Stats.
 */

import { WORKOUT_KINDS, type WorkoutKind, type WorkoutSet } from "../shared/types.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const FILE = "workouts.json";
const REPS = 10;

export function readWorkouts(): WorkoutSet[] {
	try {
		const all = JSON.parse(readStateFile(statePath(FILE)) ?? "[]");
		return Array.isArray(all) ? all : [];
	} catch {
		return [];
	}
}

export function isWorkoutKind(kind: unknown): kind is WorkoutKind {
	return WORKOUT_KINDS.includes(kind as WorkoutKind);
}

export function addWorkout(kind: WorkoutKind, at = new Date()): WorkoutSet {
	const set = { at: at.toISOString(), kind, reps: REPS };
	writeStateFile(statePath(FILE), `${JSON.stringify([...readWorkouts(), set])}\n`);
	return set;
}
