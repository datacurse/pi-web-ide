/**
 * rotation.ts — which exercise the workout dialog asks for next.
 *
 * Every set adds 1 to the fatigue of each muscle group it works, halving
 * every HALF_LIFE_MIN minutes. The next exercise is the one whose most tired
 * group is freshest, so worked groups rest while others work. Near ties are
 * broken at random, and the last exercise is never repeated when another is on.
 *
 * `plan` lays the day out: a set is due `every` minutes after the last one
 * done or skipped (or when a snooze ends), inside the working hours, and the
 * rest follow `every` minutes apart until those hours end, each picked as if
 * the ones before it were done. Seeded by the last set, so the plan holds
 * still between polls and only moves when a set is done, skipped or snoozed.
 */

import {
  EXERCISES,
  MUSCLES,
  type Muscle,
  type WorkoutKind,
  type WorkoutPlanned,
  type WorkoutSchedule,
  type WorkoutSet,
} from "./types.js";

const HALF_LIFE_MIN = 45;
/** Scores this close to the best count as a tie, for variety among rested groups. */
const TIE = 0.25;

export function fatigue(
  sets: WorkoutSet[],
  now: number,
): Record<Muscle, number> {
  const out = Object.fromEntries(MUSCLES.map((m) => [m, 0])) as Record<
    Muscle,
    number
  >;
  for (const s of sets) {
    const minutes = (now - Date.parse(s.at)) / 60_000;
    if (!(minutes >= 0) || minutes > 24 * 60) continue;
    for (const m of EXERCISES[s.kind].muscles)
      out[m] += 0.5 ** (minutes / HALF_LIFE_MIN);
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
  const last = sets.reduce<WorkoutSet | undefined>(
    (a, s) => (!a || s.at > a.at ? s : a),
    undefined,
  )?.kind;
  const pool = on.length > 1 ? on.filter((k) => k !== last) : on;
  const score = (k: WorkoutKind) =>
    Math.max(...EXERCISES[k].muscles.map((m) => f[m]));
  const best = Math.min(...pool.map(score));
  const near = pool.filter((k) => score(k) <= best + TIE);
  return near[Math.floor(random() * near.length)] ?? null;
}

/** A small seeded generator (mulberry32), so a plan is the same on every poll. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `t` moved into the working hours: before them to their start, after them to the next day's start. */
function intoHours(t: number, s: WorkoutSchedule): number {
  const d = new Date(t);
  const start = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    s.from,
  ).getTime();
  const end = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    s.to,
  ).getTime();
  if (t < start) return start;
  if (t >= end)
    return new Date(
      d.getFullYear(),
      d.getMonth(),
      d.getDate() + 1,
      s.from,
    ).getTime();
  return t;
}

/**
 * The sets planned from the next one due to the end of its working hours.
 * The first may be overdue (`at` before `now`); the rest count from now.
 * `since` is the last set done or skipped, 0 for none; `snoozedUntil` 0 for none.
 */
export function plan(
  sets: WorkoutSet[],
  on: WorkoutKind[],
  schedule: WorkoutSchedule,
  since: number,
  snoozedUntil: number,
  now: number,
  limit = 300,
): WorkoutPlanned[] {
  if (on.length === 0) return [];
  const every = schedule.every * 60_000;
  const first = intoHours(
    Math.max(since ? since + every : now, snoozedUntil),
    schedule,
  );
  const d = new Date(first);
  const end = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    schedule.to,
  ).getTime();
  const random = seeded(
    Math.floor(since / 1000) ^ Math.floor(snoozedUntil / 1000),
  );
  const recent = sets.filter((s) => Date.parse(s.at) > first - 24 * 3_600_000);
  const out: WorkoutPlanned[] = [];
  for (
    let at = first;
    at < end && out.length < limit;
    at = Math.max(at, now) + every
  ) {
    const done = [
      ...recent,
      ...out.map((p) => ({ ...p, amount: EXERCISES[p.kind].amount })),
    ];
    const kind = pickNext(done, on, at, random);
    if (!kind) break;
    out.push({ at: new Date(at).toISOString(), kind });
  }
  return out;
}

/**
 * The next `days` days, each planned as a whole working day from `from` to
 * `to`, as counts per exercise. Each day starts rested; the rotation runs as
 * it would live.
 */
export function daysAhead(
  on: WorkoutKind[],
  schedule: WorkoutSchedule,
  now: number,
  days: number,
): { at: string; kinds: Partial<Record<WorkoutKind, number>> }[] {
  const today = new Date(now);
  return Array.from({ length: days }, (_, i) => {
    const start = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + i + 1,
      schedule.from,
    ).getTime();
    const kinds: Partial<Record<WorkoutKind, number>> = {};
    for (const p of plan(
      [],
      on,
      schedule,
      start - schedule.every * 60_000,
      0,
      start,
    ))
      kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    return { at: new Date(start).toISOString(), kinds };
  });
}
