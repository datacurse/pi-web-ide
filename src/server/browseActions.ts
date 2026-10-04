import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import { copyEntry, createEntry, moveEntry, trashEntry } from "./files.js";
import { listProjects } from "./projects.js";

export type BrowseAction = {
  root: string;
  action: "file" | "folder" | "rename" | "move" | "copy" | "trash";
  name: string;
  target?: string;
};

/**
 * Explicit file-manager operations outside added projects. This is a separate
 * boundary from the editor: sources must be direct children of the browsed
 * directory, names cannot traverse, and destinations must be existing folders.
 * Never change the editor's project containment rules to enable this picker.
 */
export function browseAction(cwd: string, b: BrowseAction): string | void {
  const folder = (path: string) => {
    if (typeof path !== "string" || !path.trim())
      throw new Error("directory required");
    const raw = path.trim();
    const full = realpathSync(
      resolve(raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw),
    );
    if (!statSync(full).isDirectory()) throw new Error("not a directory");
    return full;
  };
  const name = (value: string) => {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      value.includes("\\") ||
      value.includes("\0")
    )
      throw new Error("a single file or folder name is required");
    return value;
  };
  const root = folder(b.root);
  const source = join(root, name(b.name));
  if (b.action === "rename" || b.action === "move" || b.action === "trash") {
    for (const project of listProjects(cwd)) {
      let full: string;
      try {
        full = realpathSync(project);
      } catch {
        full = resolve(project);
      }
      const rel = relative(source, full);
      if (
        rel === "" ||
        (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep))
      )
        throw new Error(
          "cannot move or trash an added project or its parent folder",
        );
    }
  }
  // The unrestricted seed is deliberate and confined to this explicit API.
  // Existing operation helpers still protect registered project roots and
  // refuse overwrites. Canonical parents prevent traversal through symlinks.
  const seed = parse(root).root;
  switch (b.action) {
    case "file":
    case "folder":
      return createEntry(seed, source, b.action === "folder");
    case "rename":
      return moveEntry(seed, source, join(root, name(b.target ?? "")));
    case "move":
      return moveEntry(
        seed,
        source,
        join(folder(b.target ?? ""), basename(source)),
      );
    case "copy":
      return copyEntry(seed, source, folder(b.target ?? ""));
    case "trash":
      return trashEntry(seed, source);
    default:
      throw new Error("unknown file operation");
  }
}
