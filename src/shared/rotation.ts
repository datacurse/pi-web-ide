/**
 * rotation.ts — which exercise the workout dialog asks for next.
 *
 * Every set adds 1 to the fatigue of each muscle group it works, halving
 * every HALF_LIFE_MIN minutes. The next exercise is the one whose most tired
 * group is freshest, so worked groups rest while others work. Near ties are
 * broken at random, and the last exercise is never repeated when another is on.
 */

import { EXERCISES, MUSCLES, type Muscle, type WorkoutKind, type WorkoutSet } from "./types.js";

const HALF_LIFE_MIN = 45;
/** Scores this close to the best count as a tie, for variety among rested groups. */
const TIE = 0.25;

export function fatigue(sets: WorkoutSet[], now: number): Record<Muscle, number> {
	const out = Object.fromEntries(MUSCLES.map((m) => [m, 0])) as Record<Muscle, number>;
	for (const s of sets) {
		const minutes = (now - Date.parse(s.at)) / 60_000;
		if (!(minutes >= 0) || minutes > 24 * 60) continue;
		for (const m of EXERCISES[s.kind].muscles) out[m] += 0.5 ** (minutes / HALF_LIFE_MIN);
	}
	return out;
}

export function pickNext(
	sets: WorkoutSet[],
	on: WorkoutKind[],
	now = Date.now(),
	random = Math.random,
): WorkoutKind | null {
	if (on.length === 0) return null;
	const f = fatigue(sets, now);
	const last = sets.reduce<WorkoutSet | undefined>((a, s) => (!a || s.at > a.at ? s : a), undefined)?.kind;
	const pool = on.length > 1 ? on.filter((k) => k !== last) : on;
	const score = (k: WorkoutKind) => Math.max(...EXERCISES[k].muscles.map((m) => f[m]));
	const best = Math.min(...pool.map(score));
	const near = pool.filter((k) => score(k) <= best + TIE);
	return near[Math.floor(random() * near.length)] ?? null;
}
