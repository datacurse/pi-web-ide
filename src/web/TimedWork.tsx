import { activityGroups } from "../shared/activity.js";
import { ActivityPanel } from "./Activity.js";
import { RawBlocks } from "./RawOutput.js";
import { WorkTool } from "./WorkTimeline.js";
import type { RawRow } from "./rawTurns.js";
import { phaseBlocks } from "./turnPhases.js";
import { useAnchorSources } from "./anchorDiff.js";

/** Reuse the recorded phases while keeping today's tool and Markdown renderer. */
export function TimedWork({ row }: { row: RawRow }) {
  const sources = useAnchorSources(row.work ?? []);
  const activity = row.activity;
  if (!activity || !activity.steps.length) return null;
  const groups = activityGroups(activity);
  let blocks: ReturnType<typeof phaseBlocks> | undefined;
  return (
    <>
      <ActivityPanel
        activity={activity}
        liveContent={
          <RawBlocks
            blocks={(row.work ?? []).filter(
              (block) => block.kind === "text" || block.kind === "image",
            )}
            streaming={row.running}
          />
        }
        breakdownAvailable
        renderContent={(round) => {
          const roundBlocks = (blocks ??= phaseBlocks(
            groups,
            row.workMessages ?? [],
            row.workPartial,
          ));
          const content = round.groups
            .flatMap((group) => roundBlocks.get(group.id) ?? [])
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
    </>
  );
}
