/**
 * pwiExtensions.ts — the switches on the Packages page's pwi extensions tab:
 * the tool-metrics collector, one of the pi extensions pwi loads into the
 * sessions it starts (on unless turned off), and the workout gate, which the
 * browser applies before each send (off unless turned on). The page shows them
 * beside the personality (personality.ts).
 */

import { WORKOUT_KINDS, type PwiExtensions, type WorkoutKind } from "../shared/types.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";
import { isWorkoutKind } from "./workouts.js";
import { parseProfile } from "../shared/calories.js";

const FILE = "pwi-extensions.json";

function read(): Record<string, unknown> {
	try {
		return JSON.parse(readStateFile(statePath(FILE)) ?? "{}");
	} catch {
		return {};
	}
}

export function readToolMetrics(): boolean {
	return read().toolMetrics !== false;
}

export function pwiExtensions(): PwiExtensions {
	const s = read();
	return {
		toolMetrics: s.toolMetrics !== false,
		workout: s.workout === true,
		workoutOff: Array.isArray(s.workoutOff) ? s.workoutOff.filter(isWorkoutKind) : [],
		workoutProfile: parseProfile(s.workoutProfile),
	};
}

function write(next: PwiExtensions): PwiExtensions {
	writeStateFile(statePath(FILE), `${JSON.stringify(next)}\n`);
	return next;
}

export function writePwiExtension(key: "toolMetrics" | "workout", on: boolean): PwiExtensions {
	return write({ ...pwiExtensions(), [key]: on });
}

/** Null when the profile is out of bounds; a null profile clears it. */
export function writeWorkoutProfile(profile: unknown): PwiExtensions | null {
	const parsed = parseProfile(profile);
	if (profile !== null && !parsed) return null;
	return write({ ...pwiExtensions(), workoutProfile: parsed });
}

/** Null when `off` names an unknown exercise or leaves none on. */
export function writeWorkoutOff(off: unknown): PwiExtensions | null {
	if (!Array.isArray(off) || !off.every(isWorkoutKind)) return null;
	const set = [...new Set(off as WorkoutKind[])];
	if (set.length >= WORKOUT_KINDS.length) return null;
	return write({ ...pwiExtensions(), workoutOff: set });
}
