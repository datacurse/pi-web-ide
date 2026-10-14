import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { safePath } from "./files.js";

/** Watch only expanded folders; coalesce bursts and release everything on detach. */
export function watchFiles(
  cwd: string,
  root: string,
  dirs: string[],
  changed: () => void,
) {
  let timer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];
  for (const rel of ["", ...dirs].slice(0, 500)) {
    try {
      const watcher = watch(safePath(cwd, join(root, rel)), () => {
        clearTimeout(timer);
        timer = setTimeout(changed, 250);
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      // Gone or outside every project: nothing to watch there.
    }
  }
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
