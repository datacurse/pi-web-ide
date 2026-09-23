/**
 * Copy the VS Code Material file icons into public/.
 *
 * They are ~3.8 MB of SVG that belongs to a dependency, so they are not
 * committed: this runs on postinstall and puts them where Vite copies
 * public/ from and the Node server serves dist/ from.
 *
 * Exits 0 when the package is missing. A production install without dev
 * dependencies should not fail its install over an icon set, and the tree
 * still renders — just with broken <img> alt text instead of glyphs.
 */
import { cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const from = join(root, "node_modules/vscode-material-icons/generated/icons");
const to = join(root, "public/material-icons");

try {
	await stat(from);
} catch {
	console.warn("sync-icons: vscode-material-icons not installed, skipping");
	process.exit(0);
}

// Overwrite in place, never `rm -rf` first. Any `pnpm add` re-runs this, and a
// delete-then-copy leaves the directory empty for a second or two — long
// enough for a live dev server to 404 whatever the tree asked for, and an
// <img> that 404s stays broken until the page reloads. The cost is that an
// icon renamed away in a package upgrade lingers as an unreferenced file.
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log(`sync-icons: copied ${from} -> ${to}`);
