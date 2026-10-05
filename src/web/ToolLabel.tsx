import { useContext, useSyncExternalStore } from "react";
import {
  BookOpen,
  MagnifyingGlass,
  PencilSimple,
  ClipboardText,
  TerminalWindow,
  Code,
  Wrench,
} from "@phosphor-icons/react";
import type { PiTool } from "../shared/types.js";
import type { AnchorSource } from "./anchorDiff.js";
import { toolCategory, toolDescription } from "./workTimeline.js";
import {
  readCodemodeToolLabels,
  subscribeCodemodeToolLabels,
  readRelativeToolPaths,
  subscribeRelativeToolPaths,
} from "./prefs.js";
import { ToolCwdContext, toolPathLabel } from "./toolPaths.js";

export function ToolLabel({
  tool,
  source,
  codemodeChild = false,
}: {
  tool: PiTool;
  source?: AnchorSource;
  codemodeChild?: boolean;
}) {
  const preference = useSyncExternalStore(
    subscribeCodemodeToolLabels,
    readCodemodeToolLabels,
    () => "text" as const,
  );
  const relative = useSyncExternalStore(
    subscribeRelativeToolPaths,
    readRelativeToolPaths,
    () => true,
  );
  const cwd = useContext(ToolCwdContext);
  const displayPath = (path: string) => toolPathLabel(path, cwd, relative);
  const args =
    tool.args && typeof tool.args === "object"
      ? (tool.args as Record<string, unknown>)
      : {};
  const description = toolDescription(
    typeof args.path === "string"
      ? { ...tool, args: { ...args, path: displayPath(args.path) } }
      : tool,
  );
  const separator = description === tool.name ? -1 : description.indexOf(" ");
  const action = separator < 0 ? description : description.slice(0, separator);
  const name = tool.name.split(".").at(-1) ?? tool.name;
  const mode =
    name === "codemode" ? "both" : codemodeChild ? preference : "text";
  const icons = mode !== "text";
  const location = tool.source ?? source;
  const path =
    location?.path ?? (typeof args.path === "string" ? args.path : undefined);
  const paths = Array.isArray(args.paths)
    ? args.paths
        .filter((value): value is string => typeof value === "string")
        .map(displayPath)
        .join(", ")
    : "";
  const line = location?.line;
  const currentLine = location?.currentLine;
  const target = path
    ? `${displayPath(path)}${line !== undefined ? ` L${line}` : currentLine !== undefined ? ` (current L${currentLine})` : ""}`
    : paths;
  const anchor = [args.remove_from, args.remove_to, args.anchor]
    .filter((value): value is string => typeof value === "string")
    .join("–");
  const fallback =
    target ||
    (anchor
      ? `Unknown file · anchor ${anchor}`
      : typeof args.query === "string"
        ? args.query
        : typeof args.pattern === "string"
          ? args.pattern
          : typeof args.scope === "string"
            ? args.scope
            : "");
  const parameters =
    separator < 0
      ? fallback
        ? ` ${fallback}`
        : ""
      : description.slice(separator);
  const category = toolCategory(tool);
  const Icon =
    category === "file"
      ? BookOpen
      : category === "search"
        ? MagnifyingGlass
        : [
              "replace",
              "insert",
              "write",
              "edit",
              "ast_grep_replace",
              "undo_last_change",
            ].includes(name)
          ? PencilSimple
          : name === "lens_diagnostics"
            ? ClipboardText
            : name === "bash" || name === "exec"
              ? TerminalWindow
              : name === "codemode"
                ? Code
                : Wrench;
  return (
    <>
      {icons && (
        <>
          <span
            role="img"
            aria-label={action}
            title={action}
            className="inline-flex align-middle text-neutral-200"
          >
            <Icon size={16} />
          </span>
          {mode === "both" ? " " : ""}
        </>
      )}
      {mode !== "icon" && <span className="text-neutral-200">{action}</span>}
      {parameters && <span className="text-neutral-500">{parameters}</span>}
    </>
  );
}
