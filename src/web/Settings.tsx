import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Bell, ChatText, ListBullets, Palette, UserCircle } from "@phosphor-icons/react";
import { Button, inputClass, NavItem, OptionRow, PanelHeader, Section } from "./ui.js";
import { LANGUAGES, THEMES, TOOL_MODES, type Language, type ThemeId, type ToolMode } from "./prefs.js";
import { api } from "./api.js";
import { t } from "./i18n.js";

/** What GET/PUT /api/personality answer with. */
interface Personality {
	path: string;
	content: string;
	exists: boolean;
	remind: boolean;
}

type SaveState = "idle" | "saving" | "saved";

const CATEGORIES = [
	{ id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
	{ id: "transcript", label: "Transcript", icon: <ChatText size={16} /> },
	{ id: "sessions", label: "Sessions", icon: <ListBullets size={16} /> },
	{ id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
	{ id: "personality", label: "Personality", icon: <UserCircle size={16} /> },
] as const;
type Category = (typeof CATEGORIES)[number]["id"];

/**
 * Four squares of a palette's actual colors: backdrop, border, body text,
 * accent.
 *
 * The colors come from the SAME `data-theme` mechanism that paints the app,
 * so a preview cannot drift from what selecting it will look like, and no hex
 * value is duplicated outside index.css. The frame is deliberately outside
 * the themed subtree so it stays in the palette currently in use.
 */
function Swatch({ theme }: { theme: ThemeId }) {
	return (
		<span
			aria-hidden
			className="flex shrink-0 overflow-hidden rounded-sm border border-neutral-700"
		>
			<span data-theme={theme} className="flex">
				<span className="block size-4 bg-neutral-950" />
				<span className="block size-4 bg-neutral-800" />
				<span className="block size-4 bg-neutral-100" />
				<span className="block size-4 bg-amber-400" />
			</span>
		</span>
	);
}

/**
 * The Settings page, shown in the page dialog: one <fieldset> per setting, all but the
 * personality browser-local (see prefs.ts).
 *
 * Stays mounted once opened, so an unsaved personality edit survives
 * closing the dialog. `open` is "the dialog is showing it".
 */
export function Settings({
	open,
	theme,
	onTheme,
	language,
	onLanguage,
	showThinking,
	onShowThinking,
	toolMode,
	onToolMode,
	notify,
	onNotify,
	shortNames,
	onShortNames,
	onClose,
}: {
	open: boolean;
	theme: ThemeId;
	onTheme: (theme: ThemeId) => void;
	language: Language;
	onLanguage: (language: Language) => void;
	showThinking: boolean;
	onShowThinking: (show: boolean) => void;
	toolMode: ToolMode;
	onToolMode: (mode: ToolMode) => void;
	notify: boolean;
	onNotify: (on: boolean) => void;
	shortNames: boolean;
	onShortNames: (on: boolean) => void;
	onClose: () => void;
}) {
	/*
	 * Permission is read at render rather than stored: the browser owns it,
	 * it can be revoked from the address bar at any time, and a copy in React
	 * state would be the stale one. Both branches disable the control, for
	 * different reasons the hint has to tell apart — "your browser cannot"
	 * and "you told your browser not to" are not the same answer.
	 */
	const supported = typeof Notification !== "undefined";
	const notifyBlocked = !supported || Notification.permission === "denied";
	const notifyHint = !supported
		? t("This browser does not support notifications.")
		: Notification.permission === "denied"
			? t("Blocked — allow notifications for this site in your browser.")
			: t("Only when the page is in the background. Shows the first line of the answer.");

	/*
	 * Personality lives on the server, so unlike every other control here it
	 * has to be fetched — and it is fetched by this component rather than
	 * lifted into App, because nothing outside the dialog reads it and a piece
	 * of state whose only consumer is one panel does not belong three levels up.
	 *
	 * Reloaded on every open so an edit made in $EDITOR (or on another machine's
	 * pwi) is what you see — EXCEPT when there are unsaved edits, which a
	 * refetch would silently throw away. Closing the dialog by accident is one
	 * Escape press; losing the paragraph you just typed to it would be pwi's
	 * fault, not yours.
	 */
	const [personality, setPersonality] = useState<Personality | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("idle");
	const [saveError, setSaveError] = useState<string | null>(null);
	const dirty = draft !== null && draft !== personality?.content;

	const [loadError, setLoadError] = useState<string | null>(null);
	const [category, setCategory] = useState<Category>("appearance");
	const [query, setQuery] = useState("");
	const results = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open || dirty) return;
		void (async () => {
			// The personality on screen is the selected host's, not this page's.
			const r = await api.personality.$get().catch(() => null);
			/*
			 * Every failure mode ends up as a message, never as a control that
			 * sits on "loading…" forever. The one that actually happened: a
			 * browser running this code against a pwi process started before the
			 * endpoint existed, where the SPA fallback answered with index.html
			 * and a 200 — so a successful-looking response whose body is not JSON
			 * has to be treated as the version mismatch it is.
			 */
			const loaded = r?.ok
				? ((await r.json().catch(() => null)) as Personality | null)
				: null;
			if (!loaded || typeof loaded.content !== "string") {
				setLoadError(
					r && !r.ok
						? t("could not read it (HTTP {status})", { status: r.status })
						: t("could not read it — is this pwi older than the field? restart it"),
				);
				return;
			}
			setPersonality(loaded);
			setDraft(loaded.content);
			setSaveState("idle");
			setSaveError(null);
			setLoadError(null);
		})();
		// `dirty` is deliberately not a dependency: this runs on open, and
		// re-running it the moment an edit is undone would refetch mid-typing.
	}, [open]);

	// Saved on click like every other checkbox here, independent of the text's
	// Save button, since it is its own file on the server.
	const saveRemind = async (remind: boolean) => {
		const r = await api.personality.remind.$put({ json: { remind } }).catch(() => null);
		if (!r?.ok) {
			setSaveError(t("could not save the reminder setting"));
			return;
		}
		setPersonality((p) => (p ? { ...p, remind } : p));
	};

	const savePersonality = async () => {
		if (draft === null) return;
		setSaveState("saving");
		setSaveError(null);
		const r = await api.personality.$put({ json: { content: draft } }).catch(() => null);
		const body = (await r?.json().catch(() => ({}))) as Partial<Personality> & {
			error?: string;
		};
		if (!r?.ok) {
			setSaveState("idle");
			setSaveError(body.error ?? t("could not save"));
			return;
		}
		// The server answers with what it wrote (a trailing newline may have
		// been added), so the draft is reconciled against the file rather than
		// against what was typed — otherwise the field stays "dirty" forever.
		const saved: Personality = {
			path: body.path ?? personality?.path ?? "",
			content: body.content ?? draft,
			exists: true,
			remind: body.remind ?? personality?.remind ?? false,
		};
		setPersonality(saved);
		setDraft(saved.content);
		setSaveState("saved");
	};

	/*
	 * Every setting as one searchable item: `label` is its name (fuzzy-matched),
	 * `text` everything else a search should find it by. Items render in
	 * category order, so a search result reads like the pages it came from.
	 */
	const items: { category: Category; label: string; text: string; node: ReactNode }[] = [
		{
			category: "appearance",
			label: t("Theme"),
			text: `color colour palette dark light ${THEMES.map((th) => th.label).join(" ")}`,
			node: (
				// Real radios, visually hidden: the group gets arrow-key navigation,
				// roving focus and the right screen reader announcement for free.
				<div role="radiogroup" aria-label={t("Theme")} className="flex flex-col gap-0.5">
					{THEMES.map((th, i) => [
						th.light !== THEMES[i - 1]?.light && (
							<div key={th.light ? "light" : "dark"} className="px-2 pt-1 pb-1 text-ui text-neutral-300">
								{th.light ? t("Light") : t("Dark")}
							</div>
						),
						<OptionRow key={th.id} selected={th.id === theme}>
							<input
								type="radio"
								name="theme"
								value={th.id}
								checked={th.id === theme}
								onChange={() => onTheme(th.id)}
								className="sr-only"
							/>
							<Swatch theme={th.id} />
							<span className="flex-1">{th.label}</span>
							<span aria-hidden className={th.id === theme ? "text-amber-400" : "invisible"}>
								{"\u2713"}
							</span>
						</OptionRow>,
					])}
				</div>
			),
		},
		{
			category: "appearance",
			label: t("Language"),
			text: `language interface english russian ${LANGUAGES.map((l) => l.label).join(" ")}`,
			node: (
				<div role="radiogroup" aria-labelledby="language-label">
					<div id="language-label" className="px-2 pt-1 pb-1 text-ui text-neutral-300">
						{t("Language")}
					</div>
					{LANGUAGES.map((l) => (
						<OptionRow key={l.id} selected={l.id === language}>
							<input
								type="radio"
								name="language"
								value={l.id}
								checked={l.id === language}
								onChange={() => onLanguage(l.id)}
								className="size-3.5 shrink-0 accent-amber-400"
							/>
							<span lang={l.id} className="flex-1">
								{l.label}
							</span>
						</OptionRow>
					))}
				</div>
			),
		},
		{
			category: "transcript",
			label: t("Show thinking"),
			text: t("Reasoning blocks in assistant messages, as they stream and in history."),
			node: (
				// A real checkbox, visible rather than sr-only: there is no swatch
				// to carry the state, so the box itself is the affordance.
				<OptionRow>
					<input
						type="checkbox"
						checked={showThinking}
						onChange={(e) => onShowThinking(e.target.checked)}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Show thinking")}
						<span className="block text-meta text-neutral-500">
							{t("Reasoning blocks in assistant messages, as they stream and in history.")}
						</span>
					</span>
				</OptionRow>
			),
		},
		{
			category: "transcript",
			label: t("Tool calls"),
			text: `tools collapse expand ${TOOL_MODES.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
			node: (
				// Radios, not a second checkbox: "collapsed" and "hidden" are
				// different answers to one question.
				<div role="radiogroup" aria-labelledby="tool-mode-label">
					<div id="tool-mode-label" className="px-2 pt-1 pb-1 text-ui text-neutral-300">
						{t("Tool calls")}
					</div>
					{TOOL_MODES.map((m) => (
						<OptionRow key={m.id} selected={m.id === toolMode}>
							<input
								type="radio"
								name="toolMode"
								value={m.id}
								checked={m.id === toolMode}
								onChange={() => onToolMode(m.id)}
								className="size-3.5 shrink-0 accent-amber-400"
							/>
							<span className="flex-1">
								{t(m.label)}
								<span className="block text-meta text-neutral-500">{t(m.hint)}</span>
							</span>
						</OptionRow>
					))}
				</div>
			),
		},
		{
			category: "sessions",
			label: t("Short names from the first prompt"),
			text: `title rename ${t("Names an unnamed session by the opening words of your first message instead of showing the whole line. A name you set with the pencil in the session list always wins.")}`,
			node: (
				<OptionRow>
					<input
						type="checkbox"
						checked={shortNames}
						onChange={(e) => onShortNames(e.target.checked)}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Short names from the first prompt")}
						<span className="block text-meta text-neutral-500">
							{t(
								"Names an unnamed session by the opening words of your first message instead of showing the whole line. A name you set with the pencil in the session list always wins.",
							)}
						</span>
					</span>
				</OptionRow>
			),
		},
		{
			category: "notifications",
			label: t("Notify when a run finishes"),
			text: `alert desktop done ${notifyHint}`,
			node: (
				<OptionRow disabled={notifyBlocked}>
					<input
						type="checkbox"
						checked={notify}
						disabled={notifyBlocked}
						onChange={(e) => onNotify(e.target.checked)}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Notify when a run finishes")}
						<span className="block text-meta text-neutral-500">{notifyHint}</span>
					</span>
				</OptionRow>
			),
		},
		{
			category: "personality",
			label: t("Personality"),
			text: `system prompt instructions ${t("Appended to every new session's system prompt")}`,
			/*
			  The one control here that is not browser-local: it edits this
			  server's own personality.md, in the state directory. The path is
			  shown because a field that silently writes a file somewhere is
			  worse than no field, and the hint says when the change lands —
			  the file is handed to each child as `--append-system-prompt` at
			  spawn, so a running session keeps the prompt it started with.
			*/
			node: (
				<>
					<label className="block px-2">
						<span className="text-ui text-neutral-300">
							{t("Appended to every new session's system prompt")}
						</span>
						<span className="mt-0.5 block font-mono text-meta break-all text-neutral-500">
							{loadError ? (
								<span className="text-red-400">{loadError}</span>
							) : (
								<>
									{personality?.path ?? t("loading…")}
									{personality && !personality.exists && ` ${t("(not created yet)")}`}
								</>
							)}
						</span>
						<textarea
							value={draft ?? ""}
							onChange={(e) => {
								setDraft(e.target.value);
								setSaveState("idle");
							}}
							disabled={draft === null}
							rows={10}
							spellCheck={false}
							placeholder={loadError ? t("Unavailable.") : t("Empty means nothing is appended.")}
							className={`mt-2 block w-full resize-y font-mono ${inputClass.sm}`}
						/>
					</label>
					<div className="mt-2 flex items-center gap-2 px-2">
						<Button
							variant="subtle"
							size="sm"
							onClick={() => void savePersonality()}
							disabled={!dirty || saveState === "saving"}
						>
							{saveState === "saving" ? t("Saving…") : t("Save")}
						</Button>
						<span className="min-w-0 flex-1 text-meta text-neutral-500">
							{saveError ? (
								<span className="text-red-400">{saveError}</span>
							) : dirty ? (
								t("Unsaved changes.")
							) : saveState === "saved" ? (
								t("Saved. Applies to sessions started from now on.")
							) : (
								t("Read from disk each time Settings is shown.")
							)}
						</span>
					</div>
				</>
			),
		},
		{
			category: "personality",
			label: t("Repeat before every reply"),
			text: `remind tokens drift ${t("Also adds the text to the end of each of your messages on every model request, so long sessions do not drift from it. Costs its length in tokens per message, mostly at the cache-read rate. Applies to sessions started from now on.")}`,
			node: (
				<OptionRow>
					<input
						type="checkbox"
						checked={personality?.remind ?? false}
						disabled={!personality}
						onChange={(e) => void saveRemind(e.target.checked)}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Repeat before every reply")}
						<span className="block text-meta text-neutral-500">
							{t(
								"Also adds the text to the end of each of your messages on every model request, so long sessions do not drift from it. Costs its length in tokens per message, mostly at the cache-read rate. Applies to sessions started from now on.",
							)}
						</span>
					</span>
				</OptionRow>
			),
		},
	];

	const searching = query.trim() !== "";
	const shown = items
		.map((i) => ({
			...i,
			hit: searching
				? matches(query, i.label, `${t(CATEGORIES.find((c) => c.id === i.category)?.label ?? "")} ${i.text}`)
				: i.category === category && ("none" as const),
		}))
		.filter((i) => i.hit);
	const hitCategories = new Set(shown.map((i) => i.category));

	// Paint matches with the CSS Custom Highlight API (see `::highlight(settings-search)`
	// in index.css): ranges over the rendered text, so no setting's markup has to know
	// about search.
	useLayoutEffect(() => {
		const root = results.current;
		if (!root || typeof Highlight === "undefined") return;
		const ranges = highlightRanges(root, query);
		if (!ranges.length) return;
		CSS.highlights.set("settings-search", new Highlight(...ranges));
		return () => void CSS.highlights.delete("settings-search");
	});

	return (
		<section
			aria-label={t("Settings")}
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-neutral-950 text-neutral-100"
		>
			<PanelHeader title={t("Settings")} onClose={onClose} />
			<div className="flex min-h-0 flex-1">
				<nav
					aria-label={t("Settings categories")}
					className="flex w-48 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-neutral-800 p-2"
				>
					<input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							// Escape clears a query first; a cancelled keydown fires no
							// close request on the page <dialog>.
							if (e.key !== "Escape" || !query) return;
							e.preventDefault();
							e.stopPropagation();
							setQuery("");
						}}
						placeholder={t("Search settings")}
						aria-label={t("Search settings")}
						className={`mb-2 w-full ${inputClass.sm}`}
					/>
					{CATEGORIES.map((c) => (
						<NavItem
							key={c.id}
							icon={c.icon}
							selected={!searching && c.id === category}
							// While searching, categories without a hit fade, so the list
							// doubles as a map of where the matches are.
							className={searching && !hitCategories.has(c.id) ? "opacity-50" : ""}
							onClick={() => {
								setQuery("");
								setCategory(c.id);
							}}
						>
							{t(c.label)}
						</NavItem>
					))}
				</nav>
				<div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
					<div ref={results} className="mx-auto w-full max-w-xl p-6">
						{searching && !shown.length && (
							<p className="px-2 text-ui text-neutral-500">{t("No settings match “{query}”.", { query: query.trim() })}</p>
						)}
						{CATEGORIES.filter((c) => hitCategories.has(c.id)).map((c, n) => (
							<Section key={c.id} title={t(c.label)} className={n ? "mt-6" : ""}>
								<div className="flex flex-col gap-2">
									{shown
										.filter((i) => i.category === c.id)
										.map((i) => (
											<div key={i.label} data-hit={i.hit} data-label={i.label}>
												{i.node}
											</div>
										))}
								</div>
							</Section>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}

/** Lowercase without accents, so "frappe" finds "Frappé". */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * Every word of the query somewhere in the label or text, or — for typos and
 * abbreviations like "shthk" — the whole query as a subsequence of the label.
 * Fuzzy only on the label: over a paragraph of hint text nearly anything
 * would be a subsequence.
 */
export function matches(query: string, label: string, text: string): "words" | "fuzzy" | null {
	const terms = fold(query).split(/\s+/).filter(Boolean);
	const all = fold(`${label} ${text}`);
	if (terms.every((t) => all.includes(t))) return "words";
	const needle = terms.join("");
	if (needle.length < 3) return null;
	let i = 0;
	for (const c of fold(label)) if (c === needle[i] && ++i === needle.length) return "fuzzy";
	return null;
}

/**
 * Ranges to highlight under `root`: every query word in the visible text, except
 * in a fuzzy hit, where it is the subsequence's letters in the setting's name.
 */
function highlightRanges(root: HTMLElement, query: string): Range[] {
	const terms = fold(query).split(/\s+/).filter(Boolean);
	if (!terms.length) return [];
	const needle = terms.join("");
	const ranges: Range[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		// Folded char by char, keeping each folded char's index in the raw text,
		// so a match in "frappe" lands on "Frappé".
		const map: number[] = [];
		let folded = "";
		for (let i = 0; i < node.data.length; i++) {
			const f = fold(node.data[i]);
			folded += f;
			for (let k = 0; k < f.length; k++) map.push(i);
		}
		const add = (from: number, to: number) => {
			const r = new Range();
			r.setStart(node, map[from]);
			r.setEnd(node, map[to - 1] + 1);
			ranges.push(r);
		};
		const item = node.parentElement?.closest<HTMLElement>("[data-hit]");
		if (item?.dataset.hit === "fuzzy") {
			if (folded.trim() !== fold(item.dataset.label ?? "")) continue;
			let i = 0;
			for (let at = 0; at < folded.length && i < needle.length; at++)
				if (folded[at] === needle[i]) {
					add(at, at + 1);
					i++;
				}
			continue;
		}
		for (const t of terms)
			for (let at = folded.indexOf(t); at >= 0; at = folded.indexOf(t, at + t.length)) add(at, at + t.length);
	}
	return ranges;
}
