/**
 * fileIcon.tsx — VS Code's default file icons (Seti, `vs-seti`).
 *
 * Seti is a font, not a set of SVGs: one 37 KB woff (public/seti.woff) and a
 * table mapping names to a glyph and a color (seti.json, trimmed from VS
 * Code's vs-seti-icon-theme.json by `node scripts/seti.mjs`). Like VS Code,
 * it has no folder icons; a directory row shows only its chevron.
 *
 * Lookup follows VS Code: whole filename, then extension (longest first, so
 * `test.ts` beats `ts`), then language id, then the default page glyph.
 */
import seti from "./seti.json";

type Icon = [code: number, dark: string, light: string];
// SAFETY: scripts/seti.mjs writes every icon as [codepoint, dark, light];
// JSON import types arrays as (string | number)[], not a tuple.
const ICONS = seti.icons as unknown as Record<string, Icon>;
const NAMES: Record<string, string> = seti.fileNames;
const EXTS: Record<string, string> = seti.fileExtensions;
const LANGS: Record<string, string> = seti.languageIds;

/**
 * Extension → VS Code language id. Upstream maps the common languages by id,
 * not extension, because VS Code resolves ids from each language extension's
 * own registration — which a browser does not have.
 *
 * ponytail: hand-kept, covers the common ones. Add a line when a type shows
 * the default glyph but has a Seti icon in LANGS.
 */
const LANG_BY_EXT: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "typescriptreact",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "javascriptreact",
	json: "json",
	jsonc: "jsonc",
	jsonl: "jsonl",
	css: "css",
	pcss: "postcss",
	scss: "scss",
	less: "less",
	html: "html",
	htm: "html",
	xml: "xml",
	md: "markdown",
	markdown: "markdown",
	py: "python",
	pyi: "python",
	pyw: "python",
	yml: "yaml",
	yaml: "yaml",
	sh: "shellscript",
	bash: "shellscript",
	zsh: "shellscript",
	fish: "shellscript",
	bat: "bat",
	cmd: "bat",
	ps1: "powershell",
	psm1: "powershell",
	psd1: "powershell",
	c: "c",
	i: "c",
	cpp: "cpp",
	cc: "cpp",
	cxx: "cpp",
	cu: "cuda-cpp",
	m: "objective-c",
	mm: "objective-cpp",
	cs: "csharp",
	fs: "fsharp",
	go: "go",
	rs: "rust",
	rb: "ruby",
	php: "php",
	java: "java",
	groovy: "groovy",
	swift: "swift",
	dart: "dart",
	lua: "lua",
	pl: "perl",
	pm: "perl",
	jl: "julia",
	clj: "clojure",
	cljs: "clojure",
	coffee: "coffeescript",
	sql: "sql",
	tex: "latex",
	sty: "tex",
	hbs: "handlebars",
	pug: "jade",
	cshtml: "razor",
	properties: "properties",
	env: "dotenv",
	gitignore: "ignore",
	gitkeep: "ignore",
	dockerfile: "dockerfile",
	mk: "makefile",
	diff: "diff",
};

/** Whole filenames that carry a language id with no extension to hang it on. */
const LANG_BY_NAME: Record<string, string> = {
	dockerfile: "dockerfile",
	containerfile: "dockerfile",
	makefile: "makefile",
	gnumakefile: "makefile",
	"docker-compose.yml": "dockercompose",
	"docker-compose.yaml": "dockercompose",
	"compose.yml": "dockercompose",
	"compose.yaml": "dockercompose",
	".env": "dotenv",
};

/** The Seti icon id for a filename. */
export function iconIdFor(name: string): string {
	const lower = name.toLowerCase();
	if (NAMES[lower]) return NAMES[lower];
	// Every suffix after a dot, longest first. A dotfile's leading dot counts,
	// the way VS Code reads `.gitattributes` as extension `gitattributes`.
	const exts: string[] = [];
	for (let i = lower.indexOf("."); i !== -1; i = lower.indexOf(".", i + 1))
		exts.push(lower.slice(i + 1));
	for (const ext of exts) if (EXTS[ext]) return EXTS[ext];
	const lang = LANG_BY_NAME[lower] ?? LANG_BY_EXT[exts.at(-1) ?? ""];
	return (lang && LANGS[lang]) || seti.file;
}

/**
 * A file's icon: one glyph of the Seti font, colored per theme through CSS
 * variables (`.seti-icon` in index.css picks dark or light).
 */
export function FileGlyph({ name, size = 16 }: { name: string; size?: number }) {
	const [code, dark, light] = ICONS[iconIdFor(name)] ?? ICONS[seti.file];
	return (
		<span
			// The filename sits right beside it; announcing the glyph is noise.
			aria-hidden
			className="seti-icon shrink-0"
			style={
				{
					width: size,
					height: size,
					// VS Code draws the glyph at 150% of a 13px label in a 16px box.
					fontSize: size * 1.22,
					"--seti-dark": dark,
					"--seti-light": light,
				} as React.CSSProperties
			}
		>
			{String.fromCodePoint(code)}
		</span>
	);
}
