import { useCallback, useEffect, useState } from "react";
import {
  EXERCISES,
  type Muscle,
  type WorkoutKind,
  type WorkoutPlan,
} from "../shared/types.js";
import { Button } from "./ui.js";

import { api } from "./api.js";
import { WorkoutFigure } from "./workoutFigures.js";

export function muscleName(m: Muscle): string {
  switch (m) {
    case "chest":
      return "chest";
    case "arms":
      return "arms";
    case "core":
      return "core";
    case "legs":
      return "legs";
    case "glutes":
      return "glutes";
    case "calves":
      return "calves";
  }
}

/** "chest · arms · core" */
export const musclesText = (kind: WorkoutKind) =>
  EXERCISES[kind].muscles.map(muscleName).join(" · ");

/** The exercise's name (Stats) and what the dialog asks for. */
export function exerciseText(kind: WorkoutKind): {
  name: string;
  task: string;
} {
  const n = EXERCISES[kind].amount;
  switch (kind) {
    case "pushups":
      return { name: "Pushups", task: `Do ${n} pushups` };
    case "situps":
      return { name: "Situps", task: `Do ${n} situps` };
    case "squats":
      return { name: "Squats", task: `Do ${n} squats` };
    case "lunges":
      return {
        name: "Lunges",
        task: `Do ${n / 2} lunges on each leg`,
      };
    case "burpees":
      return { name: "Burpees", task: `Do ${n} burpees` };
    case "jumpingJacks":
      return {
        name: "Jumping jacks",
        task: `Do ${n} jumping jacks`,
      };
    case "calfRaises":
      return { name: "Calf raises", task: `Do ${n} calf raises` };
    case "gluteBridges":
      return {
        name: "Glute bridges",
        task: `Do ${n} glute bridges`,
      };
    case "plank":
      return {
        name: "Plank",
        task: `Hold a plank for ${n} seconds`,
      };
    case "wallSit":
      return {
        name: "Wall sit",
        task: `Hold a wall sit for ${n} seconds`,
      };
  }
}

const SNOOZE_MIN = 10;
const POLL_MS = 30_000;

/**
 * The workout popup: a set on its own schedule (server/workouts.ts), not tied
 * to prompts. It opens the moment one is due, in every pwi window, hidden
 * ones included, so it is waiting when you come back; a window that is not on
 * screen or not focused also raises a system notification that stays until
 * clicked. (It first waited up to 10 minutes for pi to be busy and skipped
 * hidden windows, and sets were missed.) Modal and centred over a dimmed page;
 * only Done (after the exercise's wait), Snooze or Skip closes it. Another
 * window's Done closes it here on the next poll.
 */
export function WorkoutCard() {
  const [plan, setPlan] = useState<WorkoutPlan | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(
    () => document.visibilityState === "visible",
  );
  /**
   * The due set the card is showing, and since when it has been on screen
   * (its Done countdown); null while it opened in a hidden window.
   */
  const [shown, setShown] = useState<{
    at: string;
    since: number | null;
  } | null>(null);

  const load = useCallback(async () => {
    const r = await api.workouts.plan.$get().catch(() => null);
    if (r?.ok) setPlan(await r.json());
  }, []);
  useEffect(() => {
    void load();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void load(), POLL_MS);
    const onVisibility = () => {
      setVisible(document.visibilityState === "visible");
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const next = plan?.on ? plan.planned[0] : undefined;
  const due = next ? Date.parse(next.at) : Infinity;
  useEffect(() => {
    if (!next || now < due || shown?.at === next.at) return;
    setShown({ at: next.at, since: visible ? Date.now() : null });
    if (visible && document.hasFocus()) return;
    if (
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    // One per set across windows: the same tag replaces rather than stacks.
    const n = new Notification("Workout", {
      body: exerciseText(next.kind).task,
      tag: `pwi-workout-${next.at}`,
      requireInteraction: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }, [next, due, now, visible, shown]);
  // The countdown starts once you can see it.
  useEffect(() => {
    if (visible && shown && shown.since === null)
      setShown({ ...shown, since: Date.now() });
  }, [visible, shown]);

  if (!next || shown?.at !== next.at) return null;
  const kind = next.kind;
  const left =
    shown.since === null
      ? EXERCISES[kind].wait
      : Math.max(
          0,
          EXERCISES[kind].wait - Math.floor((now - shown.since) / 1000),
        );
  /** Hide at once, then read the new plan. */
  const act = (request: () => Promise<unknown>) => {
    setShown(null);
    setPlan(null);
    void request()
      .catch(() => undefined)
      .then(load);
  };
  const done = () => act(() => api.workouts.$post({ json: { kind } }));

  return (
    <dialog
      ref={(el) => {
        // Modal, and focused itself so Enter never lands on Skip, the first button.
        if (el && !el.open) {
          el.showModal();
          el.focus();
        }
      }}
      tabIndex={-1}
      aria-label="Workout"
      // Only its buttons close it: not Escape, not a click outside.
      onCancel={(e) => e.preventDefault()}
      // Enter is Done once it unlocks.
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (left === 0) done();
      }}
      className="m-auto hidden w-[min(24rem,92vw)] flex-col items-center gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-6 text-neutral-100 shadow-2xl backdrop:bg-black/50 open:flex"
    >
      <WorkoutFigure kind={kind} className="w-full text-amber-400" />
      <p className="text-center text-title">{exerciseText(kind).task}</p>
      <p className="text-meta text-neutral-400">{musclesText(kind)}</p>
      <div className="mt-1 flex gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => act(() => api.workouts.skip.$post())}
        >
          Skip
        </Button>
        <Button
          size="sm"
          onClick={() =>
            act(() =>
              api.workouts.snooze.$post({ json: { minutes: SNOOZE_MIN } }),
            )
          }
        >
          {`Snooze ${SNOOZE_MIN} min`}
        </Button>
        <Button size="sm" variant="primary" disabled={left > 0} onClick={done}>
          {left > 0 ? `Done in ${left}s` : "Done"}
        </Button>
      </div>
    </dialog>
  );
}
