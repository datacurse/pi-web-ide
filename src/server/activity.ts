import { createHash } from "node:crypto";
import {
  ACTIVITY_STATUS,
  activityLabel,
  parseActivity,
  type ActivityKind,
  type TurnActivity,
} from "../shared/activity.js";
import { isRecord } from "./guards.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

/** Observed wall-clock phases; provider processing and network delivery remain inseparable. */
export class ActivityTracker {
  private turns: TurnActivity[] = [];
  private lastPublish = 0;
  private waitingForInput = false;
  private path: string;

  constructor(
    key: string,
    private publish: (activity: TurnActivity) => void,
  ) {
    this.path = statePath(
      `activity-${createHash("sha256").update(key).digest("hex")}.json`,
    );
    try {
      const saved: unknown = JSON.parse(readStateFile(this.path) ?? "[]");
      if (Array.isArray(saved))
        this.turns = saved.flatMap((v) => {
          const turn = parseActivity(v);
          return turn ? [turn] : [];
        });
      this.waitingForInput = this.current?.steps.at(-1)?.kind === "input";
    } catch {
      /* Missing or damaged telemetry must never prevent opening a conversation. */
    }
  }

  get history(): TurnActivity[] {
    return this.turns;
  }
  private get current(): TurnActivity | undefined {
    const turn = this.turns.at(-1);
    return turn?.end === undefined ? turn : undefined;
  }

  private emit(at: number, force = true): void {
    const turn = this.current;
    if (!turn || (!force && at - this.lastPublish < 1000)) return;
    this.lastPublish = at;
    this.publish(structuredClone(turn));
  }

  private begin(at: number, asked?: number): void {
    this.turns.push({ start: at, asked, steps: [], tools: [] });
  }

  phase(
    kind: ActivityKind,
    at = Date.now(),
    label = activityLabel(kind),
  ): void {
    if (!this.current) {
      if (at <= (this.turns.at(-1)?.end ?? -1)) return;
      this.begin(at);
    }
    const turn = this.current!;
    const previous = turn.steps.at(-1);
    // RPC receipt can trail an extension timestamp by a few milliseconds.
    at = previous ? Math.max(at, previous.start) : turn.start;
    if (["thinking", "text", "toolcall"].includes(kind)) turn.lastOutputAt = at;
    if (previous?.kind === kind && previous.label === label) return;
    if (previous) previous.end = at;
    turn.steps.push({ kind, label: label.slice(0, 240), start: at });
    this.emit(at);
  }

  finish(at = Date.now()): void {
    const turn = this.current;
    if (!turn) return;
    at = Math.max(at, turn.steps.at(-1)?.start ?? turn.start);
    const step = turn.steps.at(-1);
    if (step) step.end = at;
    // A process exit can interrupt tools; no success/error result is invented.
    for (const tool of turn.tools) tool.end ??= at;
    turn.end = at;
    this.waitingForInput = false;
    this.publish(structuredClone(turn));
    this.save();
  }

  save(): void {
    try {
      writeStateFile(this.path, JSON.stringify(this.turns));
    } catch (err) {
      console.error("[pwi] could not save activity timings:", err);
    }
  }

  private toolPhase(at: number): void {
    if (this.waitingForInput) return;
    const running =
      this.current?.tools.filter((t) => t.end === undefined) ?? [];
    this.phase(
      running.length ? "tools" : "processing",
      at,
      running.length
        ? `Running ${running.map((t) => t.label).join(" + ")}`.slice(0, 240)
        : activityLabel("processing"),
    );
  }

  record(frame: Record<string, unknown>, at = Date.now()): void {
    if (
      frame.type === "extension_ui_request" &&
      frame.method === "setStatus" &&
      frame.statusKey === ACTIVITY_STATUS
    ) {
      let signal: unknown;
      try {
        signal =
          typeof frame.statusText === "string"
            ? JSON.parse(frame.statusText)
            : undefined;
      } catch {
        return;
      }
      if (
        !isRecord(signal) ||
        !["preparing", "request", "response"].includes(String(signal.kind)) ||
        typeof signal.at !== "number" ||
        !Number.isFinite(signal.at) ||
        signal.at < 0 ||
        signal.at > at + 60_000
      )
        return;
      this.phase(
        signal.kind as ActivityKind,
        signal.at,
        signal.kind === "response" &&
          typeof signal.status === "number" &&
          signal.status >= 400
          ? `Provider responded (HTTP ${signal.status})`
          : activityLabel(signal.kind as ActivityKind),
      );
      return;
    }
    const message = isRecord(frame.message) ? frame.message : undefined;
    switch (frame.type) {
      case "message_start":
        if (
          message?.role === "user" &&
          typeof message.timestamp === "number" &&
          Number.isFinite(message.timestamp)
        ) {
          const asked = message.timestamp;
          if (
            asked < 0 ||
            this.turns.some(
              (turn) => turn.asked === asked && turn.end !== undefined,
            )
          )
            return;
          if (this.current?.asked !== undefined && this.current.asked !== asked)
            this.finish(at);
          if (!this.current) this.begin(Math.min(at, asked), asked);
          else this.current.asked = asked;
          this.phase(
            "processing",
            at,
            "Waiting for model output (request timing unavailable)",
          );
        } else if (
          message?.role === "assistant" &&
          !this.current?.steps.length
        ) {
          this.phase(
            "processing",
            at,
            "Waiting for model output (request timing unavailable)",
          );
        }
        break;
      case "agent_start":
        if (!this.current)
          this.phase(
            "processing",
            at,
            "Waiting for model output (request timing unavailable)",
          );
        break;
      case "message_update": {
        const event = frame.assistantMessageEvent;
        if (!isRecord(event) || typeof event.delta !== "string" || !event.delta)
          break;
        const kind =
          event.type === "thinking_delta"
            ? "thinking"
            : event.type === "text_delta"
              ? "text"
              : event.type === "toolcall_delta"
                ? "toolcall"
                : undefined;
        if (!kind) break;
        // Blocking prompts and running tools can coexist with a stream.
        if (
          !this.current?.tools.some((t) => t.end === undefined) &&
          this.current?.steps.at(-1)?.kind !== "input"
        )
          this.phase(kind, at);
        if (this.current) this.current.lastOutputAt = at;
        this.emit(at, false);
        break;
      }
      case "message_end":
        if (message?.role === "assistant") this.phase("processing", at);
        break;
      case "tool_execution_start": {
        if (!this.current) this.phase("processing", at);
        const args = isRecord(frame.args) ? frame.args : {};
        const detail =
          typeof args.command === "string"
            ? args.command
            : typeof args.path === "string"
              ? args.path
              : "";
        const id = String(frame.toolCallId ?? "");
        if (!this.current!.tools.some((t) => t.id === id))
          this.current!.tools.push({
            id,
            label:
              `${String(frame.toolName ?? "tool")}${detail ? `: ${detail}` : ""}`
                .replace(/\s+/g, " ")
                .slice(0, 160),
            start: at,
          });
        this.toolPhase(at);
        break;
      }
      case "tool_execution_end": {
        const tool = this.current?.tools.find(
          (t) => t.id === frame.toolCallId && t.end === undefined,
        );
        if (tool) {
          tool.end = at;
          tool.isError = frame.isError === true;
          this.toolPhase(at);
        }
        break;
      }
      case "auto_retry_start":
        this.phase(
          "retry",
          at,
          `Waiting to retry${typeof frame.attempt === "number" ? ` (attempt ${frame.attempt})` : ""}${typeof frame.delayMs === "number" ? ` · ${frame.delayMs / 1000}s backoff` : ""}`,
        );
        break;
      case "compaction_start":
        this.phase("compaction", at);
        break;
      case "compaction_end":
        this.phase("processing", at);
        break;
      case "extension_ui_request":
        if (
          ["select", "confirm", "input", "editor"].includes(
            String(frame.method),
          )
        ) {
          this.waitingForInput = true;
          this.phase("input", at);
        }
        break;
      case "agent_settled":
        this.finish(at);
        break;
    }
  }

  resumeInput(): void {
    this.waitingForInput = false;
    if (this.current?.steps.at(-1)?.kind === "input")
      this.toolPhase(Date.now());
  }

  rewind(at: number): void {
    this.turns = this.turns.filter((t) => (t.asked ?? t.start) < at);
    this.save();
  }
}
