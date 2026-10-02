import { performance } from "node:perf_hooks";

interface Message {
  role: string;
  timestamp?: number;
  usage?: { output?: number };
}
interface Pi {
  on(
    event: "message_start" | "message_end",
    handler: (event: { message: Message }) => void,
  ): void;
  on(
    event: "message_update",
    handler: (event: {
      assistantMessageEvent: { type: string; delta?: string };
    }) => void,
  ): void;
  appendEntry(type: string, data: unknown): void;
}

/** Stream timing lives in the session file, outside the model's context. */
export default function generation(pi: Pi) {
  let first: number | undefined;
  let last: number | undefined;
  pi.on("message_start", ({ message }) => {
    if (message.role === "assistant") first = last = undefined;
  });
  pi.on("message_update", ({ assistantMessageEvent: event }) => {
    if (
      !["text_delta", "thinking_delta", "toolcall_delta"].includes(
        event.type,
      ) ||
      !event.delta
    )
      return;
    last = performance.now();
    first ??= last;
  });
  pi.on("message_end", ({ message }) => {
    if (message.role !== "assistant") return;
    const ms = first !== undefined && last !== undefined ? last - first : 0;
    if (
      ms > 0 &&
      Number.isFinite(message.timestamp) &&
      Number.isFinite(message.usage?.output) &&
      message.usage!.output! > 0
    ) {
      pi.appendEntry("pwi-generation", {
        timestamp: message.timestamp,
        ms,
        tokens: message.usage!.output,
      });
    }
    first = last = undefined;
  });
}
