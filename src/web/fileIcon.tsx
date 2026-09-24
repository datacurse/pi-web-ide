/**
 * fileIcon.tsx — VS Code's actual file icons.
 *
 * These are the real Material Icon Theme SVGs (the default-ish icon set most
 * VS Code screenshots show), self-hosted from `vscode-material-icons`. The
 * previous version drew Phosphor's line-art file glyphs, which are the wrong
 * tool at 16px: detailed outlines with a letter inside turn to mush, and every
 * file read as the same grey page. These are solid, flat, high-contrast shapes
 * designed for exactly this size.
 *
 * What is deliberately NOT used is that package's JavaScript: its
 * `getIconForFilePath` drags in a 322 KB generated map covering every
 * framework config file in existence. The SVGs are the part worth having, so
 * this file keeps its own small table of the extensions this project actually
 * opens and resolves them to icon names by hand.
 *
 * ponytail: a hand-kept table. If it starts missing types often, import the
 * package's map (one import, 322 KB) instead of growing this by hand.
 */

/**
 * Where the SVGs are served from.
 *
 * `public/` is copied verbatim by Vite and served by the Node server in
 * production, so an icon is a plain URL string and the browser caches each
 * one — no bundler glob, no import per icon, and an icon nobody opens is
 * never fetched. `scripts/sync-icons.mjs` puts them there (a postinstall
 * step), because a 3.8 MB icon set does not belong in git.
 */
const BASE = "/material-icons";

const url = (name: string): string => `${BASE}/${name}.svg`;

/**
 * Whole-filename matches, checked BEFORE extensions.
 *
 * `package.json` is a Node icon, not a generic JSON one, and `.gitignore` has
 * no extension at all — an extension-only table gets both wrong.
 */
const BY_NAME: Record<string, string> = {
	"package.json": "nodejs",
	"package-lock.json": "nodejs",
	"pnpm-lock.yaml": "pnpm",
	"pnpm-workspace.yaml": "pnpm",
	"yarn.lock": "yarn",
	"bun.lockb": "bun",
	"deno.json": "deno",
	"tsconfig.json": "tsconfig",
	"jsconfig.json": "jsconfig",
	"vite.config.ts": "vite",
	"vite.config.js": "vite",
	"tailwind.config.ts": "tailwindcss",
	"tailwind.config.js": "tailwindcss",
	"knip.json": "knip",
	dockerfile: "docker",
	"docker-compose.yml": "docker",
	"docker-compose.yaml": "docker",
	makefile: "makefile",
	"readme.md": "readme",
	license: "certificate",
	"license.md": "certificate",
	"changelog.md": "changelog",
	"contributing.md": "contributing",
	".gitignore": "git",
	".gitattributes": "git",
	".gitmodules": "git",
	".editorconfig": "editorconfig",
	".npmrc": "npm",
	".nvmrc": "nodejs",
	".prettierrc": "prettier",
	".prettierignore": "prettier",
	".eslintrc": "eslint",
	".eslintrc.json": "eslint",
	"eslint.config.js": "eslint",
	".env": "tune",
	".env.local": "tune",
	".env.example": "tune",
};

const BY_EXT: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "react_ts",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "react",
	json: "json",
	jsonc: "json",
	json5: "json",
	css: "css",
	scss: "sass",
	sass: "sass",
	less: "less",
	html: "html",
	htm: "html",
	vue: "vue",
	svelte: "svelte",
	astro: "astro",
	md: "markdown",
	mdx: "mdx",
	rst: "document",
	txt: "document",
	log: "log",
	py: "python",
	ipynb: "jupyter",
	rs: "rust",
	go: "go",
	rb: "ruby",
	php: "php",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	dart: "dart",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	lua: "lua",
	r: "r",
	pl: "perl",
	ex: "elixir",
	exs: "elixir",
	erl: "erlang",
	hs: "haskell",
	clj: "clojure",
	scala: "scala",
	zig: "zig",
	nim: "nim",
	sh: "console",
	bash: "console",
	zsh: "console",
	fish: "console",
	bat: "console",
	cmd: "console",
	ps1: "powershell",
	sql: "database",
	db: "database",
	sqlite: "database",
	prisma: "prisma",
	graphql: "graphql",
	gql: "graphql",
	proto: "proto",
	yml: "yaml",
	yaml: "yaml",
	toml: "settings",
	ini: "settings",
	conf: "settings",
	cfg: "settings",
	env: "tune",
	properties: "settings",
	xml: "xml",
	csv: "table",
	tsv: "table",
	xls: "table",
	xlsx: "table",
	svg: "svg",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	avif: "image",
	bmp: "image",
	ico: "image",
	mp4: "video",
	webm: "video",
	mov: "video",
	mp3: "audio",
	wav: "audio",
	ogg: "audio",
	flac: "audio",
	woff: "font",
	woff2: "font",
	ttf: "font",
	otf: "font",
	eot: "font",
	pdf: "pdf",
	doc: "word",
	docx: "word",
	ppt: "powerpoint",
	pptx: "powerpoint",
	zip: "zip",
	tar: "zip",
	gz: "zip",
	tgz: "zip",
	rar: "zip",
	"7z": "zip",
	lock: "lock",
	key: "key",
	pem: "certificate",
	crt: "certificate",
	wasm: "assembly",
	diff: "diff",
	patch: "diff",
};

/**
 * Directory names with their own icon. Kept short on purpose: a folder icon
 * per framework is noise, but `src`, `test` and `node_modules` are landmarks
 * you navigate by.
 */
const BY_DIR: Record<string, string> = {
	src: "folder-src",
	source: "folder-src",
	lib: "folder-lib",
	dist: "folder-dist",
	build: "folder-dist",
	out: "folder-dist",
	test: "folder-test",
	tests: "folder-test",
	__tests__: "folder-test",
	spec: "folder-test",
	node_modules: "folder-node",
	public: "folder-public",
	static: "folder-public",
	assets: "folder-resource",
	images: "folder-images",
	img: "folder-images",
	docs: "folder-docs",
	doc: "folder-docs",
	scripts: "folder-scripts",
	config: "folder-config",
	server: "folder-server",
	client: "folder-client",
	web: "folder-client",
	api: "folder-api",
	components: "folder-components",
	hooks: "folder-hook",
	utils: "folder-utils",
	types: "folder-typescript",
	styles: "folder-css",
	deploy: "folder-docker",
	".git": "folder-git",
	".github": "folder-github",
	".vscode": "folder-vscode",
	shared: "folder-shared",
	tmp: "folder-temp",
	temp: "folder-temp",
	coverage: "folder-coverage",
};

/** The icon NAME for a filename, before it is resolved to a URL. */
export function iconNameFor(name: string): string {
	const lower = name.toLowerCase();
	const named = BY_NAME[lower];
	if (named) return named;
	// `.gitignore` has only a leading dot, so it has no extension: only a dot
	// at index > 0 separates one.
	const dot = lower.lastIndexOf(".");
	const ext = dot > 0 ? lower.slice(dot + 1) : "";
	return BY_EXT[ext] ?? "file";
}

/** The icon name for a directory, open or closed. */
export function dirIconNameFor(name: string, open: boolean): string {
	const base = BY_DIR[name.toLowerCase()] ?? "folder";
	return open ? `${base}-open` : base;
}

/**
 * A file's icon.
 *
 * `<img>` rather than an inlined SVG: the browser caches each one, an unused
 * icon is never fetched, and a tree of 200 rows costs 200 cache hits instead
 * of 200 parsed SVG subtrees.
 */
export function FileGlyph({ name, size = 16 }: { name: string; size?: number }) {
	return (
		<img
			src={url(iconNameFor(name))}
			width={size}
			height={size}
			// The filename sits right beside it; a screen reader announcing
			// "TypeScript icon, App.tsx" is the same thing twice.
			alt=""
			aria-hidden
			draggable={false}
			className="shrink-0"
		/>
	);
}

/** A folder's icon. Open and closed differ, the way a tree's should. */
export function FolderGlyph({
	name,
	open,
	size = 16,
}: {
	name: string;
	open: boolean;
	size?: number;
}) {
	return (
		<img
			src={url(dirIconNameFor(name, open))}
			width={size}
			height={size}
			alt=""
			aria-hidden
			draggable={false}
			className="shrink-0"
		/>
	);
}
