import type { PiPartial } from "../shared/types.js";
import { emptyPartial } from "../shared/partial.js";

/** Only the chat subscribes: token delivery must not rerender the app shell. */
export function createPartialStore() {
  let value = emptyPartial();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (change: PiPartial | ((current: PiPartial) => PiPartial)) => {
      const next = typeof change === "function" ? change(value) : change;
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

export type PartialStore = ReturnType<typeof createPartialStore>;
