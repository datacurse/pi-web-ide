/**
 * calories.ts — what a workout set burns, estimated.
 *
 * kcal = MET × resting kcal per minute × minutes of work. 1 MET is taken as
 * this body's own resting rate (Mifflin–St Jeor) rather than the textbook
 * 3.5 ml O2/kg/min, which is how sex, age and height count, not only weight.
 * Gross, resting burn included, like most fitness apps.
 */

import { EXERCISES, type WorkoutKind, type WorkoutProfile } from "./types.js";

/** Mifflin–St Jeor resting energy, kcal a day. */
export function restingKcalPerDay(p: WorkoutProfile): number {
	return 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === "male" ? 5 : -161);
}

/** kcal a set of `amount` (reps, or seconds held) burns. */
export function setKcal(kind: WorkoutKind, amount: number, p: WorkoutProfile): number {
	const e = EXERCISES[kind];
	const seconds = e.unit === "seconds" ? amount : amount * e.rep;
	return e.met * (restingKcalPerDay(p) / 1440) * (seconds / 60);
}

/** A profile within human bounds, or null. The server checks what the browser saves. */
export function parseProfile(x: unknown): WorkoutProfile | null {
	if (!x || typeof x !== "object") return null;
	const { sex, age, heightCm, weightKg } = x as Record<string, unknown>;
	const within = (v: unknown, lo: number, hi: number) => typeof v === "number" && v >= lo && v <= hi;
	if ((sex !== "male" && sex !== "female") || !within(age, 10, 120) || !within(heightCm, 100, 250) || !within(weightKg, 30, 300))
		return null;
	return { sex, age: age as number, heightCm: heightCm as number, weightKg: weightKg as number };
}
