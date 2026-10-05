import { CaretRight, Check, X } from "@phosphor-icons/react";
import type { PiBlock, PiTool } from "../shared/types.js";
import type { TurnActivity } from "../shared/activity.js";
import { RawBlocks } from "./RawOutput.js";
import { anchorSources, type AnchorSource } from "./anchorDiff.js";
import {
  currentWorkStatus,
  explorationLabel,
  workTimeline,
  type ThoughtItem,
} from "./workTimeline.js";
import { ShinyText } from "./ShinyText.js";

/** Native disclosures keep individual expansion state while streaming updates arrive. */
function Disclosure({
  label,
  children,
  expanded,
  active,
}: {
  label: string;
  children: React.ReactNode;
  expanded?: boolean;
  active?: boolean;
}) {
  return (
    <details
      data-custom="quiet work phase"
      open={expanded || undefined}
      className="group/phase my-3"
    >
      <summary className="group/label inline-flex cursor-pointer list-none items-center gap-1.5 chat-prose text-neutral-500 hover:text-neutral-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-neutral-500 [&::-webkit-details-marker]:hidden">
        <ShinyText text={label} active={!!active} />
        <CaretRight
          size={12}
          aria-hidden
          className="opacity-0 transition-opacity group-hover/label:opacity-100 group-focus-visible/label:opacity-100 [[open]>summary>&]:rotate-90 [[open]>summary>&]:opacity-100"
        />
      </summary>
      <div className="text-neutral-500">{children}</div>
    </details>
  );
}

function Thought({
  item,
  expanded,
  shimmer = false,
}: {
  item: ThoughtItem;
  expanded?: boolean;
  shimmer?: boolean;
}) {
  let label = item.active ? "Thinking" : "Thought";
  if (!item.active && item.durationMs !== undefined) {
    const seconds = Math.floor(Math.max(0, item.durationMs) / 1000);
    label = seconds === 0 ? "Thought briefly" : `Thought ${seconds}s`;
  }
  // Providers can retain empty thinking placeholders/signatures without readable text.
  if (!item.block.text.trim()) {
    if (!item.active && item.durationMs === undefined) return null;
    return (
      <div className="my-3 chat-prose text-neutral-500">
        <ShinyText text={label} active={shimmer} />
      </div>
    );
  }
  return (
    <Disclosure label={label} expanded={expanded} active={shimmer}>
      <RawBlocks blocks={[item.block]} streaming={item.active} />
    </Disclosure>
  );
}

export function WorkTool({
  tool,
  toolSources,
  nested = false,
}: {
  tool: PiTool;
  toolSources: Map<string, AnchorSource>;
  nested?: boolean;
}) {
  const content =
    tool.name === "codemode" || tool.name.endsWith(".codemode") ? (
      <div data-custom="codemode tool list" className="my-3 text-neutral-300">
        <div className="font-mono chat-code">{tool.name}</div>
        {!!tool.children?.length && (
          <div className="pl-4 [&>*]:my-0">
            {tool.children.map((child) => (
              <WorkTool
                key={child.id}
                tool={child}
                toolSources={toolSources}
                nested
              />
            ))}
          </div>
        )}
      </div>
    ) : (
      <RawBlocks
        blocks={[{ kind: "tool", ...tool }]}
        toolSources={toolSources}
      />
    );
  if (!nested) return content;
  const completed =
    !tool.running &&
    !tool.interrupted &&
    (tool.isError !== undefined ||
      (!tool.outputUnavailable && tool.result !== undefined));
  return (
    <div className="relative [&>*]:my-0">
      {completed && (
        <span
          role="img"
          aria-label={tool.isError ? "Tool failed" : "Tool succeeded"}
          className={`absolute -left-4 top-[0.25em] ${tool.isError ? "text-red-400" : "text-green-400"}`}
        >
          {tool.isError ? (
            <X size={12} weight="bold" aria-hidden />
          ) : (
            <Check size={12} weight="bold" aria-hidden />
          )}
        </span>
      )}
      {content}
    </div>
  );
}

export function WorkTimeline({
  blocks,
  activity,
  running,
  expanded,
}: {
  blocks: PiBlock[];
  activity?: TurnActivity;
  running?: boolean;
  expanded?: boolean;
}) {
  const items = workTimeline(blocks, activity, !!running);
  const toolSources = anchorSources(blocks);
  const status = running ? currentWorkStatus(activity, blocks) : undefined;
  const hasVisibleThinking = items.some(
    (item) => item.kind === "thought" && item.active,
  );
  const showStatus = !!status && !(status === "Thinking" && hasVisibleThinking);
  // One animation target: the trailing status wins over an ongoing work group.
  const shinyIndex = showStatus
    ? -1
    : items.findLastIndex((item) => item.kind !== "prose" && item.active);
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "prose")
          return <RawBlocks key={i} blocks={item.blocks} streaming={running} />;
        if (item.kind === "thought")
          return (
            <Thought
              key={i}
              item={item}
              expanded={expanded}
              shimmer={i === shinyIndex}
            />
          );
        return (
          <Disclosure
            key={i}
            label={explorationLabel(item.blocks, item.active)}
            expanded={expanded}
            active={i === shinyIndex}
          >
            {item.entries.map((entry, j) =>
              entry.kind === "thought" ? (
                <Thought key={j} item={entry} />
              ) : (
                <WorkTool
                  key={entry.id}
                  tool={entry}
                  toolSources={toolSources}
                />
              ),
            )}
          </Disclosure>
        );
      })}
      {showStatus && (
        <div role="status" className="my-3 chat-prose text-neutral-400">
          <ShinyText text={status!} />
        </div>
      )}
    </>
  );
}
