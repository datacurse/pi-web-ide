/**
 * Convert the VS Code themes bundled with @shikijs/themes into
 * src/web/vscodeThemes.json (see src/web/vscodeTheme.ts for the mapping).
 *
 * Run by hand after upgrading the package or changing the mapping
 * (`node --import tsx scripts/vscode-themes.ts`); the output is committed, so
 * the app ships a few KB of colors instead of 1.5 MB of theme files.
 */
import { writeFile } from "node:fs/promises";

import { themeNames } from "@shikijs/themes";

import { convertTheme, type VsTheme } from "../src/web/vscodeTheme.ts";

const out: Record<string, ReturnType<typeof convertTheme>> = {};
for (const id of themeNames) {
  const theme: VsTheme = (await import(`@shikijs/themes/${id}`)).default;
  out[id] = convertTheme(theme);
}
const file = new URL("../src/web/vscodeThemes.json", import.meta.url);
await writeFile(file, `${JSON.stringify(out, null, "\t")}\n`);
console.log(`${Object.keys(out).length} themes → ${file.pathname}`);
