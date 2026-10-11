import type { PiBlock, PiMessage, PiPartial, PiTool } from "../shared/types.js";
import type { TurnActivity } from "../shared/activity.js";

export type RawRow = {
  role: PiMessage["role"];
  at: number;
  answerAt?: number;
  blocks: PiBlock[];
  work?: PiBlock[];
  running?: boolean;
  workStartedAt?: number;
  workEndedAt?: number;
  /** One model roundtrip per assistant message, including the final answer. */
  roundtrips?: number;
  activity?: TurnActivity;
  workMessages?: PiMessage[];
  workPartial?: PiPartial;
};

// Reducers replace tools immutably. Keep their block wrappers stable when
// only text changes so source reconstruction and tool cards can be reused.
const toolBlocks = new WeakMap<PiTool, PiBlock>();
function toolBlock(tool: PiTool): PiBlock {
  let block = toolBlocks.get(tool);
  if (!block) {
    block = { kind: "tool", ...tool };
    toolBlocks.set(tool, block);
  }
  return block;
}

/** Keep only a settled final answer outside the work disclosure. */
function partitionTurn(
  messages: PiMessage[],
  live: boolean,
): { work: PiMessage[]; answer?: PiMessage } {
  const last = messages.at(-1);
  if (
    live ||
    !last ||
    last.role !== "assistant" ||
    last.blocks.some((b) => b.kind === "tool")
  )
    return { work: messages };
  let cut = last.blocks.length;
  while (cut > 0 && ["text", "image"].includes(last.blocks[cut - 1].kind))
    cut--;
  if (cut === last.blocks.length) return { work: messages };
  return {
    work: [
      ...messages.slice(0, -1),
      ...(cut ? [{ ...last, blocks: last.blocks.slice(0, cut) }] : []),
    ],
    answer: { ...last, blocks: last.blocks.slice(cut) },
  };
}

type CachedRow = { messages: PiMessage[]; row: RawRow };

/** A per-chat cache: retain unchanged historical rows, never an old session. */
export function createRawRows() {
  const cache: CachedRow[] = [];
  return (
    messages: PiMessage[],
    partial: PiPartial,
    busy: boolean,
    activity?: TurnActivity[],
  ) => rawRows(messages, partial, busy, activity, cache);
}

/** One disclosure per assistant turn, with only its settled final answer outside. */
export function rawRows(
  messages: PiMessage[],
  partial: PiPartial,
  busy: boolean,
  activity: TurnActivity[] = [],
  cache?: CachedRow[],
): RawRow[] {
  const rows: RawRow[] = [];
  const traces = new Map<number, TurnActivity>();
  for (const trace of activity)
    if (trace.asked !== undefined && !traces.has(trace.asked))
      traces.set(trace.asked, trace);
  const append = (source: PiMessage[], row: RawRow) => {
    if (cache) cache[rows.length] = { messages: source, row };
    rows.push(row);
  };
  let turn: PiMessage[] = [];
  let turnAt: number | undefined;
  const flush = (live: boolean) => {
    if (!turn.length && !live) return;
    const at = turnAt ?? turn[0]?.timestamp ?? 0;
    const trace = traces.get(at);
    const cached = cache?.[rows.length];
    if (
      !live &&
      cached &&
      !cached.row.running &&
      cached.row.at === at &&
      cached.row.activity === trace &&
      cached.messages.length === turn.length &&
      turn.every((message, i) => cached.messages[i] === message)
    ) {
      rows.push(cached.row);
      turn = [];
      return;
    }
    const { work, answer } = partitionTurn(turn, live);
    const blocks = work.flatMap((message) => message.blocks);
    if (live)
      blocks.push(
        ...(partial.thinking
          ? [{ kind: "thinking" as const, text: partial.thinking }]
          : []),
        ...(partial.text
          ? [{ kind: "text" as const, text: partial.text }]
          : []),
        ...partial.tools.map(toolBlock),
      );
    append(turn, {
      role: "assistant",
      at,
      answerAt: answer?.timestamp,
      blocks: answer?.blocks ?? [],
      work: blocks,
      running: live,
      activity: trace,
      workMessages: work,
      workPartial: live ? partial : undefined,
      roundtrips: turn.filter((message) => message.role === "assistant").length,
      workStartedAt: trace?.start ?? turnAt ?? turn[0]?.timestamp,
      // Never use the next prompt or the current clock as a historical end time.
      workEndedAt: live ? undefined : (trace?.end ?? turn.at(-1)?.endedAt),
    });
    turn = [];
  };
  for (const message of messages) {
    if (message.role === "assistant" || message.role === "toolResult")
      turn.push(message);
    else {
      flush(false);
      const cached = cache?.[rows.length];
      if (
        cached?.messages.length === 1 &&
        cached.messages[0] === message &&
        cached.row.role === message.role
      )
        rows.push(cached.row);
      else
        append([message], {
          role: message.role,
          at: message.timestamp,
          blocks: message.blocks,
        });
      turnAt = message.timestamp;
    }
  }
  flush(
    busy || !!partial.text || !!partial.thinking || partial.tools.length > 0,
  );
  if (cache) cache.length = rows.length;
  return rows;
}
