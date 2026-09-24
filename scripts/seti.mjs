/**
 * Vendor VS Code's Seti file icon theme: public/seti.woff + src/web/seti.json.
 *
 * Run by hand to refresh (`node scripts/seti.mjs`); the output is committed.
 * The JSON is trimmed to what fileIcon.tsx reads: each icon id becomes
 * [codepoint, dark color, light color], and the four lookup tables keep their
 * ids. Upstream's light table is always `<id>_light`, so it is folded in.
 */
import { writeFile } from "node:fs/promises";

const BASE =
	"https://raw.githubusercontent.com/microsoft/vscode/main/extensions/theme-seti/icons";
const get = async (f) => {
	const res = await fetch(`${BASE}/${f}`);
	if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
	return res;
};

const theme = await (await get("vs-seti-icon-theme.json")).json();
const defs = theme.iconDefinitions;
const icons = {};
for (const [id, d] of Object.entries(defs)) {
	if (id.endsWith("_light")) continue;
	const light = defs[`${id}_light`] ?? d;
	icons[id] = [parseInt(d.fontCharacter.slice(1), 16), d.fontColor, light.fontColor];
}
const out = {
	file: theme.file,
	icons,
	fileNames: theme.fileNames,
	fileExtensions: theme.fileExtensions,
	languageIds: theme.languageIds,
};
await writeFile("src/web/seti.json", `${JSON.stringify(out)}\n`);
await writeFile("public/seti.woff", Buffer.from(await (await get("seti.woff")).arrayBuffer()));
console.log(`seti: ${Object.keys(icons).length} icons`);
