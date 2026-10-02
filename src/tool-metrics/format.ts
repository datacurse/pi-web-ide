/**
 * format.ts — one line of a tool-metrics file. See FORMAT.md.
 *
 * Shared by the collector (inside pi) and pwi's reader; imports nothing.
 */

export interface ToolMetric {
  v: 1;
  /** A call, or `background`: a job one of its steps started, written once it is gone. */
  type?: "background";
  toolCallId: string;
  tool: string;
  /** `tool_execution_start` to `tool_execution_end`, ms. A background job: launch to gone, to about 1s. */
  ms: number;
  /** `tool_result` to `tool_execution_end`: other extensions' result hooks (pi-lens), ms. */
  hookMs?: number;
  /** When the call ended (the job was seen gone), epoch ms. */
  at: number;
  /** bash: each command of the call, in order. */
  steps?: Step[];
  /** A background job: its pid, and the index of the step that started it. */
  pid?: number;
  step?: number;
}

/** One command of a bash call. A pipeline is one step; a loop body is one step run many times. */
export interface Step {
  /** As written in the command, or bash's reprint when it could not be found there. */
  text: string;
  ms: number;
  /** Exit status. Absent if the command replaced trace.bash's exit trap. */
  exit?: number;
  /** Output bytes, stdout and stderr. Absent if the markers were lost. */
  bytes?: number;
  /** Of `bytes`, those in the tail the model was shown. */
  shown?: number;
  /** How many times it ran, when more than once. */
  runs?: number;
}

/** The records in one file's text; torn or foreign lines are skipped. */
export function parseMetrics(text: string): ToolMetric[] {
  const out: ToolMetric[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Partial<ToolMetric>;
      if (
        r.v === 1 &&
        typeof r.toolCallId === "string" &&
        typeof r.ms === "number"
      )
        out.push(r as ToolMetric);
    } catch {
      // The last line may be half-written.
    }
  }
  return out;
}
