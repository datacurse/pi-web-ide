/**
 * workouts.ts — the sets done (one entry per Done in web/Workout.tsx), for the
 * Workouts tab in Stats, and the schedule's plan built from them.
 */

import { EXERCISES, WORKOUT_KINDS, type WorkoutKind, type WorkoutPlan, type WorkoutSet } from "../shared/types.js";
import { daysAhead, fatigue, plan } from "../shared/rotation.js";

/** How many days the plan reaches past today, for the chart in Stats. */
const AHEAD_DAYS = 14;
import { machines } from "./machines.js";
import { pwiExtensions } from "./pwiExtensions.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const FILE = "workouts.json";

/** This machine's sets, or another's from its mirror (machines.ts). */
export function readWorkouts(file = statePath(FILE)): WorkoutSet[] {
	try {
		const all = JSON.parse(readStateFile(file) ?? "[]");
		if (!Array.isArray(all)) return [];
		// The first sets were logged as `reps` before timed exercises existed.
		// A newer pwi elsewhere may log exercises this one does not know.
		return all
			.filter((s) => isWorkoutKind(s?.kind) && typeof s.at === "string")
			.map((s) => ({ at: s.at, kind: s.kind, amount: s.amount ?? s.reps }));
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

const STATE = "workout-state.json";

/** The last Skip and the end of the last Snooze, ISO; they move the next set like a Done does. */
interface State {
	skippedAt?: string;
	snoozedUntil?: string;
}

function readState(): State {
	try {
		return JSON.parse(readStateFile(statePath(STATE)) ?? "{}") as State;
	} catch {
		return {};
	}
}

export function skipWorkout(now = new Date()): void {
	writeStateFile(statePath(STATE), JSON.stringify({ ...readState(), skippedAt: now.toISOString() }));
}

export function snoozeWorkout(minutes: number, now = new Date()): void {
	const until = new Date(now.getTime() + minutes * 60_000).toISOString();
	writeStateFile(statePath(STATE), JSON.stringify({ ...readState(), snoozedUntil: until }));
}

/** What is coming up, over this machine's sets and every mirrored one: a set done anywhere counts. */
export function workoutPlan(now = Date.now()): WorkoutPlan {
	const s = pwiExtensions();
	const sets = [...readWorkouts(), ...machines().flatMap((m) => readWorkouts(m.workouts))];
	const state = readState();
	const since = Math.max(0, ...sets.map((x) => Date.parse(x.at)), Date.parse(state.skippedAt ?? "") || 0);
	const on = WORKOUT_KINDS.filter((k) => !s.workoutOff.includes(k));
	return {
		on: s.workout,
		schedule: s.workoutSchedule,
		planned: s.workout ? plan(sets, on, s.workoutSchedule, since, Date.parse(state.snoozedUntil ?? "") || 0, now) : [],
		ahead: s.workout ? daysAhead(on, s.workoutSchedule, now, AHEAD_DAYS) : [],
		fatigue: fatigue(sets, now),
	};
}
