import type { PiBlock, PiTool } from "../shared/types.js";
import { MarkdownText } from "./Markdown.js";
import { ToolLabel } from "./ToolLabel.js";
import { AnchorDiff } from "./AnchorDiff.js";
import { anchorDiff, anchorSources, type AnchorSource } from "./anchorDiff.js";
import { isExecTool } from "./execDisplay.js";
import { ExecBlock } from "./ExecBlock.js";
import { SourceRead, isSourceRead } from "./SourceRead.js";
import { ShellRun, isShellRun } from "./ShellRun.js";
import { SearchResults, isSearchTool } from "./SearchResults.js";

function ToolInput({ tool, source }: { tool: PiTool; source?: AnchorSource }) {
  const diff = anchorDiff(tool, source);
  if (diff) return <AnchorDiff diff={diff} />;
  return (
    <pre
      data-custom="raw tool input"
      className="my-3 whitespace-pre-wrap break-words font-mono chat-code"
    >
      {JSON.stringify(tool.args, null, 2)}
    </pre>
  );
}

function ToolOutput({ tool }: { tool: PiTool }) {
  const result = tool.result!;
  return (
    <pre
      data-custom="raw tool output"
      className="my-3 whitespace-pre-wrap break-words font-mono chat-code"
    >
      {result}
    </pre>
  );
}

/** Markdown model prose, with literal tool payloads collapsed by default. */
export function RawBlocks({
  blocks,
  streaming,
  toolSources = anchorSources(blocks),
  codemodeChild = false,
}: {
  blocks: PiBlock[];
  streaming?: boolean;
  toolSources?: Map<string, AnchorSource>;
  codemodeChild?: boolean;
}) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "image")
          return (
            <img
              key={i}
              data-custom="raw output image"
              alt="Message attachment"
              src={`data:${block.mimeType};base64,${block.data}`}
              className="my-3 max-w-full"
            />
          );
        if (block.kind === "tool" && isExecTool(block.name))
          return (
            <ExecBlock key={block.id} tool={block}>
              {block.children && (
                <RawBlocks
                  blocks={block.children.map((child) => ({
                    kind: "tool",
                    ...child,
                  }))}
                  toolSources={toolSources}
                  codemodeChild={codemodeChild}
                />
              )}
            </ExecBlock>
          );
        if (block.kind === "tool")
          return (
            <details
              key={block.id}
              data-custom="raw tool disclosure"
              className={`my-3 ${block.isError ? "text-red-300" : "text-neutral-300"}`}
            >
              <summary className="cursor-pointer list-none font-mono chat-code [&::-webkit-details-marker]:hidden">
                <ToolLabel
                  tool={block}
                  source={toolSources.get(block.id)}
                  codemodeChild={codemodeChild}
                />
              </summary>
              {isSourceRead(block) && !block.isError ? (
                <SourceRead tool={block} />
              ) : isSearchTool(block) ? (
                <SearchResults tool={block} />
              ) : isShellRun(block) ? (
                <ShellRun tool={block} />
              ) : (
                <>
                  <ToolInput tool={block} source={toolSources.get(block.id)} />
                  {block.result !== undefined && <ToolOutput tool={block} />}
                </>
              )}
              {block.children && (
                <RawBlocks
                  blocks={block.children.map((child) => ({
                    kind: "tool",
                    ...child,
                  }))}
                  toolSources={toolSources}
                  codemodeChild={
                    codemodeChild || block.name.split(".").at(-1) === "codemode"
                  }
                />
              )}
            </details>
          );
        if (
          (block.kind === "thinking" || block.kind === "text") &&
          !block.text.trim()
        )
          return null;
        return (
          <div
            key={i}
            data-custom="raw model output"
            className={`chat-prose ${block.kind === "thinking" ? "text-neutral-500" : "text-neutral-100"}`}
          >
            <MarkdownText text={block.text} streaming={streaming} />
          </div>
        );
      })}
    </>
  );
}
