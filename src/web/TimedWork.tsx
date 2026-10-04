import { activityGroups } from "../shared/activity.js";
import { ActivityPanel } from "./Activity.js";
import { RawBlocks } from "./RawOutput.js";
import type { RawRow } from "./rawTurns.js";
import { phaseBlocks } from "./turnPhases.js";
import { anchorSources } from "./anchorDiff.js";

/** Reuse the recorded phases while keeping today's tool and Markdown renderer. */
export function TimedWork({ row }: { row: RawRow }) {
  const activity = row.activity;
  if (!activity || !activity.steps.length) return null;
  const blocks = phaseBlocks(
    activityGroups(activity),
    row.workMessages ?? [],
    row.workPartial,
  );
  const sources = anchorSources(row.work ?? []);
  return (
    <ActivityPanel
      activity={activity}
      breakdownAvailable
      renderContent={(round) => (
        <RawBlocks
          blocks={round.groups.flatMap((group) => blocks.get(group.id) ?? [])}
          toolSources={sources}
          streaming={!!row.running && round.end === undefined}
        />
      )}
    />
  );
}
