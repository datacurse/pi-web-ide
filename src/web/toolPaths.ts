import { createContext } from "react";

export const ToolCwdContext = createContext("");

/** Display-only shortening; never change tool arguments or file navigation. */
export function toolPathLabel(
  path: string,
  cwd: string,
  relative: boolean,
): string {
  if (!relative || !cwd) return path;
  const normalize = (value: string) => {
    const parts: string[] = [];
    for (const part of value.replace(/\\/g, "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  };
  const absolute = /^(\/|[A-Za-z]:[\\/])/.test(path);
  const root = normalize(cwd);
  const resolved = normalize(absolute ? path : cwd + "/" + path);
  if (resolved === root) return ".";
  if (!resolved.startsWith(root === "/" ? root : root + "/")) return path;
  return resolved.slice(root === "/" ? 1 : root.length + 1);
}
