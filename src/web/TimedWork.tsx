import { activityGroups } from "../shared/activity.js";
import { ActivityPanel } from "./Activity.js";
import { RawBlocks } from "./RawOutput.js";
import { WorkTool } from "./WorkTimeline.js";
import type { RawRow } from "./rawTurns.js";
import { phaseBlocks } from "./turnPhases.js";
import { anchorSources } from "./anchorDiff.js";

/** Reuse the recorded phases while keeping today's tool and Markdown renderer. */
export function TimedWork({ row }: { row: RawRow }) {
  const activity = row.activity;
  if (!activity || !activity.steps.length) return null;
  const groups = activityGroups(activity);
  const blocks = phaseBlocks(groups, row.workMessages ?? [], row.workPartial);
  const sources = anchorSources(row.work ?? []);
  return (
    <>
      <ActivityPanel
        activity={activity}
        breakdownAvailable
        renderContent={(round) => {
          const content = round.groups
            .flatMap((group) => blocks.get(group.id) ?? [])
            .filter((block) =>
              block.kind === "thinking"
                ? !!block.text.trim()
                : block.kind === "tool",
            );
          if (!content.length) return null;
          return (
            <>
              {content.map((block, index) =>
                block.kind === "tool" ? (
                  <WorkTool key={block.id} tool={block} toolSources={sources} />
                ) : (
                  <RawBlocks
                    key={index}
                    blocks={[block]}
                    toolSources={sources}
                    streaming={!!row.running && round.end === undefined}
                  />
                ),
              )}
            </>
          );
        }}
      />
      <RawBlocks
        blocks={(row.work ?? []).filter(
          (block) => block.kind === "text" || block.kind === "image",
        )}
        streaming={row.running}
      />
    </>
  );
}
