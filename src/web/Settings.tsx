import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Bell, ChatText, GearSix, ListBullets, Palette } from "@phosphor-icons/react";
import { Button, inputClass, NavItem, OptionRow, PanelHeader, Section } from "./ui.js";
import {
	applyChatFade,
	applyFooterLayout,
	applyScrollPast,
	chatFadeOpacity,
	CHAT_FADE_RANGES,
	DEFAULT_CHAT_FADE,
	readChatFade,
	readChatFadeOn,
	readFooterLayout,
	readScrollPast,
	readScrollPastOn,
	readSettingsExpanded,
	SCROLL_PAST_RANGE,
	writeChatFadeOn,
	writeSettingsExpanded,
	type ChatFade,
	LANGUAGES,
	THEMES,
	THINKING_MODES,
	TOOL_MODES,
	USER_MODES,
	FOOTER_LAYOUTS,
	ASK_MODES,
	type AskMode,
	type Language,
	type ThemeId,
	type ThinkingMode,
	type ToolMode,
	type UserMode,
} from "./prefs.js";
import { t } from "./i18n.js";

const CATEGORIES = [
	{ id: "appearance", label: "Appearance", icon: <Palette size={16} /> },
	{ id: "transcript", label: "Transcript", icon: <ChatText size={16} /> },
	{ id: "sessions", label: "Sessions", icon: <ListBullets size={16} /> },
	{ id: "notifications", label: "Notifications", icon: <Bell size={16} /> },
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

const CHAT_FADE_FIELDS: { key: keyof ChatFade; label: string; hint: string }[] = [
	{ key: "length", label: "Length", hint: "How far above the message box it starts, in rem." },
	{ key: "floor", label: "End opacity", hint: "How visible the text stays at the box. 0 fades it out completely." },
	{ key: "easeIn", label: "Ease in", hint: "How softly the fade starts. 1 starts abruptly." },
	{ key: "drop", label: "Drop", hint: "How early it gets dim. Higher dims sooner and holds longer." },
];

/** Sliders for the transcript's fade above the composer, applied live. */
function ChatFadeControl({ expandByDefault }: { expandByDefault: boolean }) {
	const [fade, setFade] = useState(readChatFade);
	const [on, setOn] = useState(readChatFadeOn);
	const [open, setOpen] = useState(expandByDefault);
	// Flipping the default shows its effect right away.
	useEffect(() => setOpen(expandByDefault), [expandByDefault]);
	const change = (next: ChatFade) => {
		setFade(next);
		applyChatFade(next);
	};
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-1">
				<OptionRow className="flex-1">
					<input
						type="checkbox"
						checked={on}
						onChange={(e) => {
							setOn(e.target.checked);
							writeChatFadeOn(e.target.checked);
						}}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Chat fade")}
						<span className="block text-meta text-neutral-500">
							{t("Fade the chat out above the message box.")}
						</span>
					</span>
				</OptionRow>
				{on && open && (
					<Button size="sm" variant="ghost" onClick={() => change(DEFAULT_CHAT_FADE)}>
						{t("Reset")}
					</Button>
				)}
				{on && (
					// As tall as the checkbox row, square, with the row's own hover and selected fills.
					<button
						type="button"
						data-custom="settings gear"
						aria-label={open ? t("Collapse") : t("Expand")}
						title={open ? t("Collapse") : t("Expand")}
						aria-expanded={open}
						onClick={() => setOpen((o) => !o)}
						className={`flex aspect-square items-center justify-center self-stretch rounded-sm transition-colors duration-150 ease-out motion-reduce:transition-none ${
							open
								? "bg-neutral-800 text-neutral-100"
								: "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
						}`}
					>
						<GearSix size={20} />
					</button>
				)}
			</div>
			{on && open && (
				<div className="flex flex-col gap-2 px-2">
					{/* One grid for all fields: names share a column, so every description starts at the same edge. */}
					<div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
						{CHAT_FADE_FIELDS.map((f) => (
							<FadeField
								key={f.key}
								label={t(f.label)}
								hint={t(f.hint)}
								range={CHAT_FADE_RANGES[f.key]}
								value={fade[f.key]}
								onChange={(v) => change({ ...fade, [f.key]: v })}
							/>
						))}
					</div>
					<ChatFadePreview fade={fade} />
				</div>
			)}
		</div>
	);
}

/** Toggle for scrolling the transcript past its last line, with the amount while on. */
function ScrollPastControl() {
	const [on, setOn] = useState(readScrollPastOn);
	const [amount, setAmount] = useState(readScrollPast);
	const change = (nextOn: boolean, next: number) => {
		setOn(nextOn);
		setAmount(next);
		applyScrollPast(nextOn, next);
	};
	return (
		<div className="flex flex-col gap-2">
			<OptionRow>
				<input
					type="checkbox"
					checked={on}
					onChange={(e) => change(e.target.checked, amount)}
					className="size-4 shrink-0 accent-amber-400"
				/>
				<span className="flex-1">
					{t("Scroll past the end")}
					<span className="block text-meta text-neutral-500">
						{t("Let the chat scroll past its last message.")}
					</span>
				</span>
			</OptionRow>
			{on && (
				<div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 px-2">
					<FadeField
						label={t("Amount")}
						hint={t("How far, in % of the window height.")}
						range={SCROLL_PAST_RANGE}
						value={amount}
						onChange={(v) => change(true, v)}
					/>
				</div>
			)}
		</div>
	);
}

/**
 * Name with its description beside it; under them a typeable number and a slider.
 * The box keeps what you type until it leaves focus and applies it whenever it is
 * a number in range, so a half-typed "0." is not snapped back.
 */
function FadeField({
	label,
	hint,
	range: [min, max, step],
	value,
	onChange,
}: {
	label: string;
	hint: string;
	range: [number, number, number];
	value: number;
	onChange: (v: number) => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<div className="contents">
			<label htmlFor={id} className="pt-2">
				{label}
			</label>
			<span className="pt-2 text-meta text-neutral-500">{hint}</span>
			<input
					id={id}
					type="number"
					min={min}
					max={max}
					step="any"
					value={draft ?? String(value)}
					onChange={(e) => {
						setDraft(e.target.value);
						const v = e.target.valueAsNumber;
						if (v >= min && v <= max) onChange(v);
					}}
					onBlur={() => setDraft(null)}
					onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
					className={`w-16 font-mono ${inputClass.sm}`}
				/>
			<input
					data-custom="range slider"
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					aria-label={label}
					onChange={(e) => {
						setDraft(null);
						onChange(Number(e.target.value));
					}}
					style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
					className="range w-full"
				/>
		</div>
	);
}

/**
 * The curve beside a sample answer masked by the live `--chat-fade`, over a mock
 * message box. Both columns are `height` rem tall, so the chart's rows line up
 * with the text: x is opacity, y is the same vertical position as the text.
 */
function ChatFadePreview({ fade }: { fade: ChatFade }) {
	const height = fade.length + 3;
	const start = height - 0.75 - fade.length;
	const box = height - 0.75;
	const points = [`1,0`, `1,${start}`];
	for (let i = 1; i <= 48; i++) {
		const u = i / 48;
		points.push(`${chatFadeOpacity(fade, u)},${start + u * fade.length}`);
	}
	points.push(`${fade.floor},${height}`);
	return (
		<div className="mt-2 grid grid-cols-2 gap-3">
			<div>
				<svg
					viewBox={`0 0 1 ${height}`}
					preserveAspectRatio="none"
					style={{ height: `${height}rem` }}
					className="block w-full rounded-sm bg-neutral-900"
					aria-hidden
				>
					{[0.25, 0.5, 0.75].map((x) => (
						<line key={x} x1={x} x2={x} y1={0} y2={height} className="stroke-neutral-800" vectorEffect="non-scaling-stroke" />
					))}
					{[start, box].map((y) => (
						<line key={y} x1={0} x2={1} y1={y} y2={y} className="stroke-neutral-600" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
					))}
					<polygon points={`0,0 ${points.join(" ")} 0,${height}`} className="fill-amber-500/15" />
					<polyline points={points.join(" ")} fill="none" className="stroke-amber-400" strokeWidth={2} vectorEffect="non-scaling-stroke" />
				</svg>
				<div className="mt-1 flex justify-between text-caption text-neutral-500">
					<span>0</span>
					<span>{t("opacity")}</span>
					<span>1</span>
				</div>
			</div>
			<div>
				<div style={{ height: `${height}rem` }} className="fade-bottom flex flex-col justify-end overflow-hidden">
					{/* The box (overlapping 0.75rem) cuts through the middle of the last line's lowercase:
					    the paragraph's bottom is trimmed to the baseline, then half an x-height below the box. */}
					<p className="mb-[calc(0.75rem_-_0.5ex)] text-body text-neutral-200 [text-box:trim-end_ex_alphabetic]">
						{t(
							"The tests pass and the build is clean. I renamed the helper, moved the parser into its own module and updated every caller, so nothing else should need to change. The old export stays as an alias for one release.",
						)}
					</p>
				</div>
				<div className="relative -mt-3 rounded-lg bg-neutral-900 px-3 py-2 text-body text-neutral-600 ring-1 ring-neutral-800 ring-inset">
					{t("Message pi…")}
				</div>
			</div>
		</div>
	);
}

/**
 * The Settings page, shown in the page dialog: one <fieldset> per setting, all
 * browser-local (see prefs.ts). The personality, which is the server's, lives
 * in Packages with the other pwi extensions.
 */
export function Settings({
	theme,
	onTheme,
	language,
	onLanguage,
	thinkingMode,
	onThinkingMode,
	toolMode,
	onToolMode,
	userMode,
	onUserMode,
	askMode,
	onAskMode,
	notify,
	onNotify,
	shortNames,
	onShortNames,
	hideScrollbars,
	onHideScrollbars,
	onClose,
}: {
	theme: ThemeId;
	onTheme: (theme: ThemeId) => void;
	language: Language;
	onLanguage: (language: Language) => void;
	thinkingMode: ThinkingMode;
	onThinkingMode: (mode: ThinkingMode) => void;
	toolMode: ToolMode;
	onToolMode: (mode: ToolMode) => void;
	userMode: UserMode;
	onUserMode: (mode: UserMode) => void;
	askMode: AskMode;
	onAskMode: (mode: AskMode) => void;
	notify: boolean;
	onNotify: (on: boolean) => void;
	shortNames: boolean;
	onShortNames: (on: boolean) => void;
	hideScrollbars: boolean;
	onHideScrollbars: (on: boolean) => void;
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

	const [category, setCategory] = useState<Category>("appearance");
	const [expandDetails, setExpandDetails] = useState(readSettingsExpanded);
	const [footer, setFooter] = useState(readFooterLayout);
	const [query, setQuery] = useState("");
	const results = useRef<HTMLDivElement>(null);

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
			label: t("Reasoning"),
			text: `reasoning thinking ${THINKING_MODES.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
			node: (
				<div role="radiogroup" aria-labelledby="thinking-mode-label">
					<div id="thinking-mode-label" className="px-2 pt-1 pb-1 text-ui text-neutral-300">
						{t("Reasoning")}
					</div>
					{THINKING_MODES.map((m) => (
						<OptionRow key={m.id} selected={m.id === thinkingMode}>
							<input
								type="radio"
								name="thinkingMode"
								value={m.id}
								checked={m.id === thinkingMode}
								onChange={() => onThinkingMode(m.id)}
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
			category: "appearance",
			label: t("Hide scrollbars"),
			text: `scroll bar ${t("Panes still scroll with the wheel, touch and keyboard.")}`,
			node: (
				<OptionRow>
					<input
						type="checkbox"
						checked={hideScrollbars}
						onChange={(e) => onHideScrollbars(e.target.checked)}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Hide scrollbars")}
						<span className="block text-meta text-neutral-500">
							{t("Panes still scroll with the wheel, touch and keyboard.")}
						</span>
					</span>
				</OptionRow>
			),
		},
		{
			category: "appearance",
			label: t("Chat fade"),
			text: `gradient mask composer message box ${CHAT_FADE_FIELDS.map((f) => `${t(f.label)} ${t(f.hint)}`).join(" ")}`,
			node: <ChatFadeControl expandByDefault={expandDetails} />,
		},
		{
			category: "appearance",
			label: t("Expand setting details"),
			text: `collapse open default ${t("Settings with details, like Chat fade, start expanded.")}`,
			node: (
				<OptionRow>
					<input
						type="checkbox"
						checked={expandDetails}
						onChange={(e) => {
							setExpandDetails(e.target.checked);
							writeSettingsExpanded(e.target.checked);
						}}
						className="size-4 shrink-0 accent-amber-400"
					/>
					<span className="flex-1">
						{t("Expand setting details")}
						<span className="block text-meta text-neutral-500">
							{t("Settings with details, like Chat fade, start expanded.")}
						</span>
					</span>
				</OptionRow>
			),
		},
		{
			category: "transcript",
			label: t("Scroll past the end"),
			text: `overscroll bottom padding ${t("Let the chat scroll past its last message.")} ${t("Amount")}`,
			node: <ScrollPastControl />,
		},
		{
			category: "transcript",
			label: t("Your messages"),
			text: `prompt collapse expand show more ${USER_MODES.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
			node: (
				<div role="radiogroup" aria-labelledby="user-mode-label">
					<div id="user-mode-label" className="px-2 pt-1 pb-1 text-ui text-neutral-300">
						{t("Your messages")}
					</div>
					{USER_MODES.map((m) => (
						<OptionRow key={m.id} selected={m.id === userMode}>
							<input
								type="radio"
								name="userMode"
								value={m.id}
								checked={m.id === userMode}
								onChange={() => onUserMode(m.id)}
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
			category: "transcript",
			label: t("Message footer"),
			text: `copy edit fork time buttons right left align ${FOOTER_LAYOUTS.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
			node: (
				<div role="radiogroup" aria-labelledby="footer-layout-label">
					<div id="footer-layout-label" className="px-2 pt-1 pb-1 text-ui text-neutral-300">
						{t("Message footer")}
					</div>
					{FOOTER_LAYOUTS.map((m) => (
						<OptionRow key={m.id} selected={m.id === footer}>
							<input
								type="radio"
								name="footerLayout"
								value={m.id}
								checked={m.id === footer}
								onChange={() => {
									setFooter(m.id);
									applyFooterLayout(m.id);
								}}
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
			label: t("Ask only button"),
			text: `question once sticky ${ASK_MODES.map((m) => `${t(m.label)} ${t(m.hint)}`).join(" ")}`,
			node: (
				<div role="radiogroup" aria-labelledby="ask-mode-label">
					<div id="ask-mode-label" className="px-2 pt-1 pb-1 text-ui text-neutral-300">
						{t("Ask only button")}
					</div>
					{ASK_MODES.map((m) => (
						<OptionRow key={m.id} selected={m.id === askMode}>
							<input
								type="radio"
								name="askMode"
								value={m.id}
								checked={m.id === askMode}
								onChange={() => onAskMode(m.id)}
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
