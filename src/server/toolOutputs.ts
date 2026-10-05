import { createHash } from "node:crypto";
import type { PiEvent, PiMessage, PiTool } from "../shared/types.js";
import { isRecord } from "./guards.js";
import { readStateFile, statePath, writeStateFile } from "./state.js";

const MAX_OUTPUT = 256_000;
const MAX_TOTAL = 4_000_000;
const MAX_ENTRIES = 2_000;
type Output = { result: string; isError: boolean };

/** Display-only nested outputs, kept out of the model's conversation history. */
export class ToolOutputTracker {
  private outputs = new Map<string, Output>();
  private nested = new Set<string>();
  private size = 0;
  private dirty = false;
  private file: string;

  constructor(key: string) {
    const hash = createHash("sha256").update(key).digest("hex");
    this.file = statePath(`tool-outputs-${hash}.json`);
    try {
      const saved: unknown = JSON.parse(readStateFile(this.file) ?? "null");
      if (!isRecord(saved) || saved.v !== 1 || !Array.isArray(saved.outputs))
        return;
      for (const row of saved.outputs.slice(-MAX_ENTRIES)) {
        if (
          !Array.isArray(row) ||
          typeof row[0] !== "string" ||
          !isRecord(row[1]) ||
          typeof row[1].result !== "string" ||
          typeof row[1].isError !== "boolean"
        )
          continue;
        this.set(row[0], row[1].result, row[1].isError);
      }
      this.dirty = false;
    } catch {
      // Missing or damaged display metadata must never prevent opening a session.
    }
  }

  private set(id: string, result: string, isError: boolean): void {
    const bounded =
      result.length > MAX_OUTPUT
        ? result.slice(0, MAX_OUTPUT) + "\n[Recorded output truncated]"
        : result;
    const previous = this.outputs.get(id);
    if (previous?.result === bounded && previous.isError === isError) return;
    this.size -= previous?.result.length ?? 0;
    this.outputs.delete(id);
    this.outputs.set(id, { result: bounded, isError });
    this.size += bounded.length;
    while (this.size > MAX_TOTAL || this.outputs.size > MAX_ENTRIES) {
      const oldest = this.outputs.keys().next().value;
      if (oldest === undefined) break;
      this.size -= this.outputs.get(oldest)!.result.length;
      this.outputs.delete(oldest);
    }
    this.dirty = true;
  }

  record(event: PiEvent): void {
    if (event.type === "tool_start" && event.parentId)
      this.nested.add(event.id);
    if (event.type !== "tool_end" || !this.nested.delete(event.id)) return;
    this.set(event.id, event.result, event.isError);
    this.save();
  }

  annotate(messages: PiMessage[]): PiMessage[] {
    const visit = (tool: PiTool): PiTool => {
      const output = this.outputs.get(tool.id);
      return {
        ...tool,
        ...(output
          ? {
              ...output,
              outputUnavailable: false,
              running: false,
              interrupted: false,
            }
          : {}),
        ...(tool.children ? { children: tool.children.map(visit) } : {}),
      };
    };
    return messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) =>
        block.kind === "tool" ? { kind: "tool", ...visit(block) } : block,
      ),
    }));
  }

  event(event: PiEvent): PiEvent {
    if (event.type === "message_done")
      return { ...event, message: this.annotate([event.message])[0] };
    return event;
  }

  save(): void {
    if (!this.dirty) return;
    try {
      writeStateFile(
        this.file,
        JSON.stringify({ v: 1, outputs: [...this.outputs] }),
      );
      this.dirty = false;
    } catch (error) {
      console.error("[pwi] could not save nested tool output:", error);
    }
  }
}
