import { createHash } from "node:crypto";
import type { Snapshot } from "../shared/types.js";

/**
 * Keep the final message replaceable (tool results may settle onto it).
 * Validate the entire retained prefix, not just its length or last timestamp:
 * rewinds, compaction, external writes and changed tool metadata must fall
 * back to a full snapshot rather than silently preserving stale history.
 */
export function transcriptDelta(snapshot: Snapshot, cursor?: string): Snapshot {
  const prefixCount = Math.max(0, snapshot.messages.length - 1);
  const match = cursor?.match(/^(\d+):([a-f0-9]{64})$/);
  const requested = match ? Number(match[1]) : -1;
  const hash = createHash("sha256").update(snapshot.id).update("\n");
  let from = 0;
  for (let i = 0; i < prefixCount; i++) {
    hash.update(JSON.stringify(snapshot.messages[i])).update("\n");
    if (i + 1 === requested && hash.copy().digest("hex") === match?.[2])
      from = requested;
  }
  return {
    ...snapshot,
    messages: from ? snapshot.messages.slice(from) : snapshot.messages,
    messagesFrom: from,
    messageCursor: `${prefixCount}:${hash.digest("hex")}`,
  };
}
