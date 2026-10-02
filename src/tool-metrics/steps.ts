/**
 * steps.ts — trace.bash's records and the output markers, grouped into the
 * steps of the command as written.
 *
 * bash fires a record per simple command: one per pipeline stage, one per
 * loop iteration, none for a `( … )` subshell. Each record is placed in the
 * command text (bash reprints commands with its own spacing, so both sides
 * are compared without whitespace); records joined only by a `|` are one
 * pipeline, and records placed at the same span are one step run again.
 */

import type { Step } from "./format.ts";

interface Rec {
  n: number;
  /** Epoch ms. */
  t: number;
  /** The previous command's status. */
  status: number;
  cmd: string;
}

export interface Trace {
  recs: Rec[];
  /** A background job, seen at record `n` (so started by the one before it). */
  bg: { n: number; t: number; pid: number }[];
  end?: { t: number; status: number };
}

export function parseTrace(text: string): Trace {
  const out: Trace = { recs: [], bg: [] };
  for (const line of text.split("\n")) {
    const f = line.split("\t");
    const n = Number(f[1]);
    const t = Number(f[2]) * 1000;
    if (!Number.isFinite(n) || !Number.isFinite(t)) continue;
    if (f[0] === "S" && f.length >= 5)
      out.recs.push({
        n,
        t,
        status: Number(f[3]),
        cmd: f.slice(4).join("\t").replace(/\x1d/g, "\n"),
      });
    else if (f[0] === "B" && f.length >= 4)
      out.bg.push({ n, t, pid: Number(f[3]) });
    else if (f[0] === "E" && f.length >= 4)
      out.end = { t, status: Number(f[3]) };
  }
  return out;
}

/** `s` without whitespace, and where each remaining character was. */
function squeeze(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i]!)) continue;
    text += s[i];
    at.push(i);
  }
  return { text, at };
}

export interface StepsInput {
  command: string;
  /** pi's `shellCommandPrefix`, run before the command; its records are dropped. */
  prefix?: string;
  trace: Trace;
  /** Marker number → clean output bytes before it (MarkerStrip.at). */
  marks: Map<number, number>;
  /** Clean output bytes in all. */
  total: number;
  /** Output bytes before this were cut from what the model was shown. */
  shownFrom: number;
  /** When the shell ended, epoch ms, for a trace without its exit record. */
  ended: number;
}

export function buildSteps(input: StepsInput): {
  steps: Step[];
  /** `step` is absent when the job came from a `( ... ) &` subshell, which has no record. */
  background: { pid: number; step?: number; t: number }[];
} {
  const src = squeeze(input.command);
  const prefix = squeeze(input.prefix ?? "").text;
  const placed: { rec: Rec; p: number; len: number }[] = [];
  let cursor = 0;
  for (const rec of input.trace.recs) {
    const q = squeeze(rec.cmd).text;
    let p = q ? src.text.indexOf(q, cursor) : -1;
    // A loop comes back to text already passed.
    if (p < 0 && q) p = src.text.indexOf(q);
    if (p < 0 && q && prefix.includes(q)) continue;
    placed.push({ rec, p, len: q.length });
    if (p >= 0) cursor = p + q.length;
  }

  // Consecutive records joined only by `|`: one pipeline.
  const runs: (typeof placed)[] = [];
  for (const x of placed) {
    const run = runs.at(-1);
    const prev = run?.at(-1);
    const piped =
      prev !== undefined &&
      prev.p >= 0 &&
      x.p >= prev.p + prev.len &&
      /^\|&?$/.test(src.text.slice(prev.p + prev.len, x.p));
    if (run && piped) run.push(x);
    else runs.push([x]);
  }

  const steps: Step[] = [];
  const index = new Map<string, number>();
  const stepOf = new Map<number, number>();
  runs.forEach((run, i) => {
    const first = run[0]!;
    const last = run.at(-1)!;
    const next = runs[i + 1]?.[0];
    const found = run.every((x) => x.p >= 0);
    const key = found
      ? `${first.p}:${last.p + last.len}`
      : `?${run.map((x) => x.rec.cmd).join("|")}`;
    const text = found
      ? input.command.slice(src.at[first.p], src.at[last.p + last.len - 1]! + 1)
      : run.map((x) => x.rec.cmd).join(" | ");
    const end = next?.rec.t ?? input.trace.end?.t ?? input.ended;
    const exit = next ? next.rec.status : input.trace.end?.status;
    const from = i === 0 ? 0 : input.marks.get(first.rec.n);
    const to = next ? input.marks.get(next.rec.n) : input.total;
    const bytes =
      from !== undefined && to !== undefined
        ? Math.max(0, to - from)
        : undefined;
    const shown =
      bytes !== undefined && to !== undefined
        ? Math.max(0, to - Math.max(from!, input.shownFrom))
        : undefined;

    let s = index.get(key);
    if (s === undefined) {
      s = steps.length;
      index.set(key, s);
      steps.push({ text, ms: 0 });
    } else steps[s]!.runs = (steps[s]!.runs ?? 1) + 1;
    const step = steps[s]!;
    step.ms = Math.round((step.ms + Math.max(0, end - first.rec.t)) * 10) / 10;
    if (exit !== undefined) step.exit = exit;
    if (bytes !== undefined) {
      step.bytes = (step.bytes ?? 0) + bytes;
      step.shown = (step.shown ?? 0) + shown!;
    }
    for (const x of run) stepOf.set(x.rec.n, s);
  });

  const background = input.trace.bg.map((b) => {
    const step = stepOf.get(b.n - 1);
    return { pid: b.pid, t: b.t, ...(step !== undefined && { step }) };
  });
  return { steps, background };
}
