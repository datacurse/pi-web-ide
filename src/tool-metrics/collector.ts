/**
 * collector.ts — a pi extension that times every tool call.
 *
 * pwi loads it into the sessions it starts and passes the directory in
 * `PWI_TOOL_METRICS_DIR`; without it, it does nothing. One line per call goes
 * to `<dir>/<sessionId>.jsonl` (FORMAT.md). Nothing reaches the model.
 *
 * The handlers only read the clock and append a line: synchronous, returning
 * nothing, so they can neither slow a tool noticeably nor change its result.
 * `tool_call` is never hooked, because a throw there blocks the tool. A
 * failed write turns the collector off for the rest of the session.
 *
 * It also registers bash again through bash.ts, which splits each call into
 * its commands; their times and output sizes go on the call's line, and the
 * background jobs they start are watched until gone.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BashRun, instrumentBash, type PiTools } from "./bash.ts";
import type { ToolMetric } from "./format.ts";

/** A variable, so tsc does not look for pi's package, which only resolves inside pi. */
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
/** How often a background job is checked for, ms. */
const POLL_MS = 1000;

type Event = { toolCallId: string; toolName?: string };
type Ctx = { sessionManager: { getSessionId(): string } };

/** The minimum of pi's ExtensionAPI this file uses; pi is not a dependency here. */
interface Pi {
  on(
    event: "tool_execution_start" | "tool_result" | "tool_execution_end",
    handler: (e: Event, ctx: Ctx) => void,
  ): void;
  registerTool(tool: unknown): void;
}

export default async function toolMetrics(pi: Pi) {
  const dir = process.env.PWI_TOOL_METRICS_DIR;
  if (!dir) return;
  let off = false;
  let made = false;
  const write = (sessionId: string, line: ToolMetric) => {
    if (!made) mkdirSync(dir, { recursive: true });
    made = true;
    appendFileSync(
      join(dir, `${sessionId}.jsonl`),
      `${JSON.stringify(line)}\n`,
    );
  };

  const runs = new Map<string, BashRun>();
  try {
    instrumentBash(pi, (await import(PI_PACKAGE)) as PiTools, (id, run) =>
      runs.set(id, run),
    );
  } catch {
    // Outside pi, or pi changed shape: calls are still timed whole.
  }

  /** Background jobs until they are gone; `t` is the launch, epoch ms. */
  const jobs: {
    sessionId: string;
    toolCallId: string;
    pid: number;
    step?: number;
    t: number;
  }[] = [];
  let poll: ReturnType<typeof setInterval> | undefined;
  const check = () => {
    for (const job of [...jobs]) {
      try {
        process.kill(job.pid, 0);
        continue;
      } catch (err) {
        // EPERM: alive, someone else's.
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") continue;
      }
      jobs.splice(jobs.indexOf(job), 1);
      try {
        const now = Date.now();
        write(job.sessionId, {
          v: 1,
          type: "background",
          toolCallId: job.toolCallId,
          tool: "bash",
          pid: job.pid,
          ...(job.step !== undefined && { step: job.step }),
          ms: Math.round(now - job.t),
          at: now,
        });
      } catch {
        off = true;
      }
    }
    if (jobs.length === 0 && poll) {
      clearInterval(poll);
      poll = undefined;
    }
  };

  const starts = new Map<string, number>();
  // Handlers run in load order and this one loads before installed
  // packages, so this is when the tool itself finished, before their hooks.
  const results = new Map<string, number>();

  pi.on("tool_execution_start", (e) => {
    if (!off) starts.set(e.toolCallId, performance.now());
  });
  pi.on("tool_result", (e) => {
    if (!off) results.set(e.toolCallId, performance.now());
  });
  pi.on("tool_execution_end", (e, ctx) => {
    const end = performance.now();
    const start = starts.get(e.toolCallId);
    const result = results.get(e.toolCallId);
    const run = runs.get(e.toolCallId);
    starts.delete(e.toolCallId);
    results.delete(e.toolCallId);
    runs.delete(e.toolCallId);
    if (off || start === undefined) return;
    try {
      const id = ctx.sessionManager.getSessionId();
      if (!/^[\w-]+$/.test(id)) return;
      const line: ToolMetric = {
        v: 1,
        toolCallId: e.toolCallId,
        tool: e.toolName ?? "?",
        ms: Math.round(end - start),
        ...(result !== undefined && { hookMs: Math.round(end - result) }),
        at: Date.now(),
        ...(run?.steps.length && { steps: run.steps }),
      };
      write(id, line);
      for (const b of run?.background ?? [])
        jobs.push({ sessionId: id, toolCallId: e.toolCallId, ...b });
      if (jobs.length && !poll) {
        poll = setInterval(check, POLL_MS);
        // A job still running does not keep pi alive.
        poll.unref();
      }
    } catch {
      off = true;
    }
  });
}
