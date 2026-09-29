import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowsInLineVertical, ArrowsOutLineVertical, CaretDown, CaretRight, CaretUp, Check, Copy, GitFork, PaperPlaneTilt, PencilSimple, X } from "@phosphor-icons/react";
import { AnsiHtml } from "fancy-ansi/react";
import { hasAnsi, stripAnsi } from "fancy-ansi";
import type { ContextBreakdown, ContextItem, ContextPart, PiBlock, PiImage, PiMessage, PiNotice } from "../shared/types.js";
import { api, unwrap } from "./api.js";
import { Button, IconButton, ListRow, sectionLabel } from "./ui.js";
import { MarkdownText } from "./Markdown.js";
import { timeAgo } from "./SessionList.js";
import { Attachments, Thumb } from "./Attachments.js";
import { t, plural, locale, getLanguage } from "./i18n.js";
import type { UserMode } from "./prefs.js";

/** Braille spinner, same visual language as the TUI. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinner(active: boolean, frames = SPINNER_FRAMES, ms = 80): string {
	const [i, setI] = useState(0);
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setI((v) => (v + 1) % frames.length), ms);
		return () => clearInterval(id);
	}, [active, frames, ms]);
	return frames[i % frames.length];
}

/**
 * Command output rendered as-is (`ls`, `git`, most test runners) carries
 * real ANSI SGR codes, not markdown. Rendering those raw would show the
 * literal `\x1b[32m` escape noise instead of color, so this is the one
 * place in the transcript that goes through an ANSI-to-HTML converter
 * rather than plain `whitespace-pre-wrap` text — and only when the string
 * actually contains escape codes, to avoid the extra DOM work otherwise.
 */
function AnsiOutput({ text, className }: { text: string; className?: string }) {
	if (!hasAnsi(text)) return <pre className={className}>{text}</pre>;
	return <AnsiHtml className={`${className ?? ""} whitespace-pre-wrap`} text={text} />;
}

/**
 * A one-line, ANSI-stripped preview of the result shown next to a collapsed
 * tool call, so scanning a long transcript of settled tool calls doesn't
 * require opening every single one to see what happened.
 */
function resultPreview(result: string): string {
	return stripAnsi(result).split("\n", 1)[0]?.trim() ?? "";
}

/**
 * Tool calls render as a collapsed one-liner; details are behind a click.
 *
 * `autoOpen` is the "Expand while running" setting: a call with no result yet
 * is IN FLIGHT, and opening it shows progress without a click, mirroring the
 * TUI. Settled calls are always collapsed, whatever the setting — the
 * one-liner carries the name, the outcome and a preview of the result, which
 * is what scanning a finished transcript needs.
 */
export function Tool({
	name,
	isError,
	result,
	args,
	autoOpen,
}: {
	name: string;
	isError?: boolean;
	result?: string;
	args?: unknown;
	autoOpen: boolean;
}) {
	const running = result === undefined;
	const [open, setOpen] = useState(autoOpen && running);
	/*
	 * Changing the setting has to reach calls that are ALREADY on screen:
	 * their `open` was decided at mount, so without this, switching to
	 * "Always collapsed" would leave the wall of expanded calls you switched
	 * to get rid of. Keyed on the setting alone — a call the user opened by
	 * hand stays open until the setting itself moves.
	 */
	useEffect(() => setOpen(autoOpen && result === undefined), [autoOpen]);
	const spinner = useSpinner(running);
	const preview = !open && result ? resultPreview(result) : "";
	return (
		<div className="chat-wide my-3">
			<button
				data-custom="transcript disclosure"
				onClick={() => setOpen((o) => !o)}
				className={`flex max-w-full items-center gap-1 whitespace-nowrap chat-code font-mono ${isError ? "text-red-400" : running ? "text-amber-400" : "text-neutral-500"} hover:text-neutral-300`}
			>
				{open ? <CaretDown size={11} /> : <CaretRight size={11} />}
				{name}
				{running ? (
					<span>{spinner}</span>
				) : isError ? (
					<X size={11} weight="bold" />
				) : (
					<Check size={11} weight="bold" className="text-green-400" />
				)}
				{preview && <span className="fade-end ml-1 min-w-0 font-normal text-neutral-600">{preview}</span>}
			</button>
			{open && (
				<div className="chat-code mt-1 max-h-80 overflow-auto rounded-sm bg-neutral-900 p-2 text-neutral-400">
					{args !== undefined && (
						<pre className="mb-2 whitespace-pre-wrap">
							{JSON.stringify(args, null, 2)}
						</pre>
					)}
					{result !== undefined && (
						<AnsiOutput className="whitespace-pre-wrap" text={result} />
					)}
				</div>
			)}
		</div>
	);
}

type ToolBlock = Extract<PiBlock, { kind: "tool" }>;

/** Phrases on a collapsed group line before the rest becomes "+N more". */
const SUMMARY_PHRASES = 3;

/**
 * How a run of calls reads once it is one line.
 *
 * pi's built-in tools, and nothing else: a tool absent from this table still
 * summarises — as `name ×3` — so an installed package can add one without
 * this going stale or, worse, wrong. Each entry takes the count and returns
 * the whole phrase, because English plurals are not a suffix: "searched 3
 * times" and "listed a directory" do not share a shape.
 */
const TOOL_PHRASES: Record<string, (n: number) => string> = {
	bash: (n) => plural(n, "ran a command", "ran {n} commands"),
	powershell: (n) => plural(n, "ran a command", "ran {n} commands"),
	read: (n) => plural(n, "read a file", "read {n} files"),
	edit: (n) => plural(n, "edited a file", "edited {n} files"),
	write: (n) => plural(n, "wrote a file", "wrote {n} files"),
	grep: (n) => plural(n, "grepped", "grepped {n} times"),
	find: (n) => plural(n, "found files", "found files {n} times"),
	ls: (n) => plural(n, "listed a directory", "listed {n} directories"),
};

/**
 * "Ran 3 commands, read 2 files, edited a file". Tool names in call order.
 *
 * Capped, because a run of forty calls across eight tools is a sentence
 * nobody reads and two wrapped lines where the point was one: past three
 * phrases the rest is a count, and expanding shows the truth.
 */
function summarize(calls: ToolBlock[]): string {
	const counts = new Map<string, number>();
	for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
	const phrases = [...counts].map(
		([name, n]) => TOOL_PHRASES[name]?.(n) ?? (n === 1 ? name : `${name} ×${n}`),
	);
	const shown = phrases.slice(0, SUMMARY_PHRASES);
	if (phrases.length > shown.length) shown.push(t("+{n} more", { n: phrases.length - shown.length }));
	const text = shown.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A fold of steps as ONE line — the "Grouped" and "Answer only" tool modes.
 *
 * Collapsed, it says what the fold did and how it went; expanding shows it in
 * order, each call still openable for its arguments and output.
 *
 * Reasoning interleaved with the calls is part of the work and collapses with
 * it, even with "Show reasoning" on: with a thought between every two calls,
 * a group that broke on reasoning would be a group of one, which is the wall
 * of steps this mode exists to fold away. In "Grouped" prose is what ends a
 * fold, because prose is the thing the reader came for; in "Answer only"
 * only the turn's LAST prose is that thing, so intermediate paragraphs fold
 * in too — and then the line has to stay honest about them, hence the step
 * count for a fold that ran no tools at all.
 *
 * Failures are counted on the collapsed line: a group may hide detail, never
 * the fact that something went wrong. Only the *badge* is red, though — one
 * failed call out of seventeen does not make the other sixteen failures, and
 * a whole line in red says it did.
 *
 * `streaming` is the in-flight fold: the group is the partial message, so it
 * is running even before its first call has started. Without it a fold of
 * pure reasoning reports itself finished the whole time the model is still
 * thinking.
 */
export function ToolGroup({ blocks, streaming }: { blocks: PiBlock[]; streaming?: boolean }) {
	const [open, setOpen] = useState(false);
	const calls = blocks.filter((b): b is ToolBlock => b.kind === "tool");
	const running = streaming === true || calls.some((c) => c.result === undefined);
	const failed = calls.filter((c) => c.isError).length;
	// A fold with no calls is reasoning — say so, rather than counting "steps"
	// at a reader who cannot tell what a step was.
	const thoughts = blocks.filter((b) => b.kind === "thinking").length;
	const label =
		calls.length > 0
			? summarize(calls)
			: thoughts > 0 && thoughts === blocks.length
				? running
					? t("Thinking")
					: plural(thoughts, "Thought", "Thought {n} times")
				: plural(blocks.length, "{n} step", "{n} steps");
	return (
		<div className="chat-wide my-3">
			<button
				data-custom="transcript disclosure"
				onClick={() => setOpen((o) => !o)}
				className="flex max-w-full items-center gap-1 whitespace-nowrap chat-code font-mono text-neutral-500 hover:text-neutral-300"
			>
				{open ? <CaretDown size={11} /> : <CaretRight size={11} />}
				<span className="fade-end min-w-0">{label}</span>
				{/* No spinner while running: TurnStatus below already animates, and a
				    second one on a line that joins and splits between messages
				    flickered. */}
				{running ? null : failed > 0 ? (
					<span className="flex items-center gap-1 text-red-400">
						<X size={11} weight="bold" />
						{t("{n} failed", { n: failed })}
					</span>
				) : (
					<Check size={11} weight="bold" className="text-green-400" />
				)}
			</button>
			{open && (
				<div className="chat-nested flow-trim mt-1 flow-root border-l border-neutral-800 pl-3">
					{blocks.map((b, i) => (
						<Block key={i} block={b} isUser={false} autoOpenTools={false} />
					))}
				</div>
			)}
		</div>
	);
}

/**
 * `isUser` bypasses markdown entirely: user input is verbatim text the user
 * typed, never prose to render — an accidental `*foo*` or `# heading` in a
 * question should show up exactly as typed, not get reinterpreted.
 */
export function Block({
	block,
	isUser,
	autoOpenTools,
	userMode = "clamped",
	foldThinking = false,
}: {
	block: PiBlock;
	isUser: boolean;
	autoOpenTools: boolean;
	userMode?: UserMode;
	foldThinking?: boolean;
}) {
	if (block.kind === "text")
		// No `chat-measure` on the user branch: the pill IS the column, and a
		// second centred box inside it would indent the text off its own edge.
		return isUser ? (
			<UserText key={userMode} text={block.text} mode={userMode} />
		) : (
			<MarkdownText text={block.text} />
		);
	if (block.kind === "image")
		return (
			<img
				src={`data:${block.mimeType};base64,${block.data}`}
				alt={t("attachment")}
				className="chat-wide my-3 max-h-80 rounded-sm border border-neutral-800"
			/>
		);
	if (block.kind === "thinking")
		return foldThinking ? (
			<Thought text={block.text} />
		) : (
			<Reasoning text={block.text} />
		);
	return (
		<Tool
			name={block.name}
			isError={block.isError}
			result={block.result}
			args={block.args}
			autoOpen={autoOpenTools}
		/>
	);
}

/**
 * Reasoning shown inline. Split into paragraphs so they are spaced like the
 * answer's (`my-3`), not by a raw blank line of the smaller reasoning text.
 */
export function Reasoning({ text, className = "chat-measure my-3" }: { text: string; className?: string }) {
	return (
		<div className={`${className} text-neutral-500 italic`}>
			{text
				.trim()
				.split(/\n\s*\n/)
				.map((p, i) => (
					<p key={i} className="my-3 whitespace-pre-wrap first:mt-0 last:mb-0">
						{p}
					</p>
				))}
		</div>
	);
}

/**
 * A reasoning block as one disclosure line (the "Folded" thinking setting).
 * Open while `streaming`, so you can watch what the model is working on; it
 * folds once the model moves on, and a click opens it again.
 */
export function Thought({ text, streaming = false }: { text: string; streaming?: boolean }) {
	const [open, setOpen] = useState(streaming);
	useEffect(() => {
		if (!streaming) setOpen(false);
	}, [streaming]);
	return (
		<div className="chat-wide my-3">
			<button
				data-custom="transcript disclosure"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1 chat-code font-mono text-neutral-500 hover:text-neutral-300"
			>
				{open ? <CaretDown size={11} /> : <CaretRight size={11} />}
				{streaming ? t("Thinking") : t("Thought")}
			</button>
			{open && <Reasoning text={text} className="chat-nested mt-1 border-l border-neutral-800 pl-3" />}
		</div>
	);
}

/**
 * A user message clamped to 3 lines so a long prompt does not bury the
 * transcript. The toggle shows only when the clamp actually cuts text.
 */
function UserText({ text, mode }: { text: string; mode: UserMode }) {
	const ref = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(mode !== "clamped");
	const [overflows, setOverflows] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || mode === "full") return;
		// Against 3 lines, not clientHeight, so it also holds while open.
		const check = () =>
			setOverflows(el.scrollHeight > 3 * parseFloat(getComputedStyle(el).lineHeight) + 1);
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	}, [text, mode]);
	if (mode === "full") return <div className="whitespace-pre-wrap">{text}</div>;
	return (
		<>
			<div ref={ref} className={`whitespace-pre-wrap ${open || !overflows ? "" : "fade-clamp"}`}>
				{text}
			</div>
			{overflows && (
				<Button
					variant="ghost"
					size="sm"
					className="mt-1 -ml-2"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					{open ? <CaretUp size={12} /> : <CaretDown size={12} />}
					{open ? t("Show less") : t("Show more")}
				</Button>
			)}
		</>
	);
}

/** 24_200 -> "24.2K". */
function popupTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

/**
 * How full the context is, as a ring in the composer, drawn empty before the
 * first turn rather than hidden. Clicking it opens `ContextPanel`.
 *
 * The number is pi's own `contextUsage` from `get_session_stats` (see
 * `fetchState` in src/server/agent.ts), not an estimate: it already counts
 * the system prompt, the tools and the cached prefix, and unlike the newest
 * turn's `usage` it follows a compaction back down. It goes amber at 75% and
 * red at 90%, the band where the next long tool result triggers a compaction.
 */
export function ContextMeter({
	tokens,
	window: limit,
	compacting,
	open,
	onToggle,
}: {
	tokens: number;
	window: number;
	compacting: boolean;
	open: boolean;
	onToggle: () => void;
}) {
	if (compacting) return <Compacting />;
	const share = limit > 0 ? Math.min(1, tokens / limit) : 0;
	const tone =
		share >= 0.9 ? "text-red-400" : share >= 0.75 ? "text-amber-400" : "text-neutral-400";
	const label =
		limit > 0
			? t("Context: {pct}% full ({tokens} of {limit} tokens)", {
					pct: Math.round(share * 100),
					tokens: tokens.toLocaleString(locale()),
					limit: limit.toLocaleString(locale()),
				})
			: t("Context usage");
	return (
		<IconButton label={label} onClick={onToggle} aria-expanded={open} data-context-meter round size="sm">
			<Ring share={share} stroke={1.5} className={`size-7 shrink-0 ${tone}`} />
		</IconButton>
	);
}

/** A progress ring, empty at 0. `currentColor` fills it, `neutral-700` is the track. */
function Ring({ share, className, stroke = 2 }: { share: number; className: string; stroke?: number }) {
	const r = 7 - stroke / 2;
	const around = 2 * Math.PI * r;
	return (
		<svg aria-hidden viewBox="0 0 16 16" className={`-rotate-90 ${className}`}>
			<circle cx="8" cy="8" r={r} fill="none" strokeWidth={stroke} className="stroke-neutral-700" />
			{share > 0 && (
				<circle
					cx="8"
					cy="8"
					r={r}
					fill="none"
					strokeWidth={stroke}
					stroke="currentColor"
					strokeLinecap="round"
					strokeDasharray={`${Math.max(share * around, 0.5)} ${around}`}
				/>
			)}
		</svg>
	);
}

const PARTS: Record<ContextPart["key"], { label: string; color: string }> = {
	system: { label: "System prompt", color: "bg-ctx-system" },
	tools: { label: "Tool definitions", color: "bg-ctx-tools" },
	rules: { label: "Rules", color: "bg-ctx-rules" },
	skills: { label: "Skills", color: "bg-ctx-skills" },
	personality: { label: "Personality", color: "bg-ctx-personality" },
	conversation: { label: "Conversation", color: "bg-ctx-conversation" },
};

function percentText(share: number): string {
	return share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}

/** A conversation item's name and count, as the popup shows them. `sub`: a tool's program or file. */
function itemLabel(
	key: ContextPart["key"],
	item: ContextItem,
	sub = false,
): { name: string; detail?: string; mono: boolean } {
	const tool = sub || (key === "conversation" && item.name.startsWith("tool:"));
	const n = item.count ?? 0;
	const detail = !n ? undefined : tool ? plural(n, "{n} call", "{n} calls") : String(n);
	return {
		name: tool && !sub ? item.name.slice(5) : item.name,
		detail,
		mono: tool || key === "tools" || key === "skills",
	};
}

/**
 * What fills the context, above the composer, like Cursor's. The total is the
 * meter's (pi's real count); the parts are pi's chars/4 estimates from
 * context-extension.ts, with the conversation's pieces scaled to fill what
 * the fixed parts leave of the total. Every part opens into its pieces; the
 * largest starts open. Compacting lives here now that a click on the meter
 * opens this.
 */
export function ContextPanel({
	sessionId,
	tokens,
	window: limit,
	busy,
	onCompact,
	onClose,
}: {
	sessionId: string;
	tokens: number;
	window: number;
	busy: boolean;
	onCompact: () => void;
	onClose: () => void;
}) {
	const [parts, setParts] = useState<ContextBreakdown | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState<Set<string>>(new Set());
	const box = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		unwrap(api.sessions[":id"].context.$get({ param: { id: sessionId } })).then(
			(b) => {
				if (!live) return;
				setParts(b);
				const top = b.reduce<ContextPart | undefined>((m, p) => (!m || p.tokens > m.tokens ? p : m), undefined);
				if (top?.items?.length) setOpen(new Set([top.key]));
			},
			(err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
		);
		return () => {
			live = false;
		};
	}, [sessionId]);

	// It floats over the transcript, so it may grow up to the top of the chat.
	const [room, setRoom] = useState<number>();
	useLayoutEffect(() => {
		const fit = () => {
			const el = box.current;
			const chat = el?.closest("main");
			if (el?.parentElement && chat)
				setRoom(el.parentElement.getBoundingClientRect().top - chat.getBoundingClientRect().top - 16);
		};
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, []);

	// Escape or a click anywhere else closes it; the meter's own click toggles.
	useEffect(() => {
		const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
		const down = (e: PointerEvent) => {
			const t = e.target as Element;
			if (!box.current?.contains(t) && !t.closest?.("[data-context-meter]")) onClose();
		};
		window.addEventListener("keydown", key);
		window.addEventListener("pointerdown", down);
		return () => {
			window.removeEventListener("keydown", key);
			window.removeEventListener("pointerdown", down);
		};
	}, [onClose]);

	// The conversation is what pi's total leaves after the fixed parts.
	const fixed = (parts ?? []).filter((p) => p.key !== "conversation").reduce((n, p) => n + p.tokens, 0);
	const talk = parts?.find((p) => p.key === "conversation");
	const talkReal = tokens > 0 ? Math.max(0, tokens - fixed) : (talk?.tokens ?? 0);
	const scale = talk && talk.tokens > 0 ? talkReal / talk.tokens : 0;
	const scaled = (i: ContextItem): ContextItem => ({
		...i,
		tokens: Math.round(i.tokens * scale),
		items: i.items?.map(scaled),
	});
	const rows = (parts ?? [])
		.map((p) => (p.key === "conversation" ? { ...p, tokens: talkReal, items: p.items?.map(scaled) } : p))
		.filter((p) => p.tokens > 0);
	const total = parts ? Math.max(tokens, fixed + talkReal) : tokens;
	const share = limit > 0 ? Math.min(1, total / limit) : 0;
	const tone = share >= 0.9 ? "text-red-400" : share >= 0.75 ? "text-amber-400" : "text-(--ct-teal)";
	const largest = rows
		.flatMap((p) => (p.items?.length ? p.items.map((i) => ({ key: p.key, item: i })) : []))
		.reduce<{ key: ContextPart["key"]; item: ContextItem } | undefined>(
			(m, x) => (!m || x.item.tokens > m.item.tokens ? x : m),
			undefined,
		);

	const expandable = rows.flatMap((p) => [
		...(p.items?.some((i) => i.tokens > 0) ? [p.key] : []),
		...(p.items ?? []).filter((i) => i.items?.some((s) => s.tokens > 0)).map((i) => `${p.key}/${i.name}`),
	]);
	/** A piece's row; a tool whose calls split by program or file opens into them. */
	const itemRow = (key: ContextPart["key"], i: ContextItem, of: number, id: string, sub = false): ReactNode => {
		const l = itemLabel(key, i, sub);
		const subs = i.items?.filter((s) => s.tokens > 0) ?? [];
		const expanded = open.has(id);
		const cells = (
			<>
				{subs.length > 0 && (
					<span aria-hidden className="w-3 shrink-0 text-neutral-500">
						{expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
					</span>
				)}
				<span className={`min-w-0 fade-end ${l.mono ? "font-mono" : ""}`}>{l.name}</span>
				{l.detail && <span className="shrink-0 text-neutral-500">{l.detail}</span>}
				<span aria-hidden className="ml-auto h-1 w-16 shrink-0 overflow-hidden rounded-full bg-neutral-800">
					<span className={`block h-full ${PARTS[key].color}`} style={{ width: `${(i.tokens / of) * 100}%` }} />
				</span>
				<span className="w-10 text-right tabular-nums text-neutral-500">{percentText(i.tokens / total)}</span>
				<span className="w-12 text-right tabular-nums">{popupTokens(i.tokens)}</span>
			</>
		);
		// A caret sits left of the name, so the name lines up with its siblings'.
		const indent = sub ? "pl-16" : subs.length > 0 ? "pl-7" : "pl-12";
		const row = `flex w-full items-center gap-2 py-0.5 pr-3 text-left text-meta text-neutral-400 ${indent}`;
		return (
			<div key={id}>
				{subs.length > 0 ? (
					<button
						data-custom="transcript disclosure"
						title={i.name}
						aria-expanded={expanded}
						onClick={() => toggle(id)}
						className={`${row} hover:bg-neutral-800`}
					>
						{cells}
					</button>
				) : (
					<div title={i.name} className={row}>
						{cells}
					</div>
				)}
				{expanded && subs.map((s) => itemRow(key, s, i.tokens, `${id}/${s.name}`, true))}
			</div>
		);
	};
	const allOpen = expandable.length > 0 && expandable.every((k) => open.has(k));
	const toggle = (key: string) =>
		setOpen((o) => {
			const n = new Set(o);
			if (!n.delete(key)) n.add(key);
			return n;
		});

	return (
		<div
			ref={box}
			style={{ maxHeight: room }}
			className="absolute inset-x-0 bottom-full z-10 mb-2 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 py-2"
		>
			<div className="flex items-center justify-between px-3 text-neutral-300">
				{t("Context Usage")}
				<div className="flex items-center gap-1">
					{expandable.length > 0 && (
						<IconButton
							label={allOpen ? t("Collapse all") : t("Expand all")}
							size="sm"
							onClick={() => setOpen(new Set(allOpen ? [] : expandable))}
						>
							{allOpen ? <ArrowsInLineVertical size={14} /> : <ArrowsOutLineVertical size={14} />}
						</IconButton>
					)}
					<IconButton label={t("Close")} size="sm" onClick={onClose}>
						<X size={14} />
					</IconButton>
				</div>
			</div>

			<div className="mt-1 flex items-center gap-3 px-3">
				<div className="relative flex shrink-0 items-center justify-center">
					<Ring share={share} stroke={1.5} className={`size-14 ${tone}`} />
					<span className="absolute text-meta font-semibold tabular-nums text-neutral-100">
						{limit > 0 ? percentText(share) : "?"}
					</span>
				</div>
				<div className="min-w-0 tabular-nums">
					<div>
						<span className="text-title text-neutral-100">~{popupTokens(total)}</span>
						<span className="text-neutral-400">
							{" "}
							/ {limit > 0 ? popupTokens(limit) : "?"} {t("tokens")}
						</span>
					</div>
					<div className="text-meta text-neutral-500">
						{limit > 0 && t("{n} free", { n: popupTokens(Math.max(0, limit - total)) })}
						{largest && total > 0 && (
							<>
								{` · ${t("largest:")} `}
								<span className="text-neutral-300">{itemLabel(largest.key, largest.item).name}</span>
								{` (${percentText(largest.item.tokens / total)})`}
							</>
						)}
					</div>
				</div>
			</div>

			{/* What the used part is made of, full width so small parts still show. */}
			<div className="mx-3 mt-3 flex h-2 gap-px overflow-hidden rounded-full bg-neutral-800">
				{total > 0 &&
					rows.map((p) => (
						<span
							key={p.key}
							title={`${t(PARTS[p.key].label)}: ${popupTokens(p.tokens)}`}
							className={`min-w-0.5 ${PARTS[p.key].color}`}
							style={{ width: `${(p.tokens / total) * 100}%` }}
						/>
					))}
			</div>

			{error ? (
				<div className="mt-2 px-3 text-meta text-red-400">{error}</div>
			) : !parts ? (
				<div className="mt-2 px-3 text-meta text-neutral-500">{t("Measuring…")}</div>
			) : (
				<div className="mt-2">
					{rows.map((p) => {
						const items = p.items?.filter((i) => i.tokens > 0) ?? [];
						const expanded = open.has(p.key);
						return (
							<div key={p.key}>
								<ListRow
									onClick={() => items.length > 0 && toggle(p.key)}
									aria-expanded={items.length > 0 ? expanded : undefined}
									className="gap-2"
								>
									<span aria-hidden className="w-3 text-neutral-500">
										{items.length > 0 &&
											(expanded ? <CaretDown size={12} /> : <CaretRight size={12} />)}
									</span>
									<span aria-hidden className={`size-3 shrink-0 rounded-sm ${PARTS[p.key].color}`} />
									<span className="text-neutral-200">{t(PARTS[p.key].label)}</span>
									{items.length > 0 && (
										<span className="text-meta text-neutral-500">{items.length}</span>
									)}
									<span className="ml-auto w-10 text-right text-meta tabular-nums text-neutral-500">
										{percentText(p.tokens / total)}
									</span>
									<span className="w-12 text-right tabular-nums text-neutral-300">
										{popupTokens(p.tokens)}
									</span>
								</ListRow>
								{expanded && items.map((i) => itemRow(p.key, i, p.tokens, `${p.key}/${i.name}`))}
							</div>
						);
					})}
				</div>
			)}

			<div className="mt-2 flex items-center justify-between gap-3 px-3">
				<span className="text-meta text-neutral-500">
					{t("The total is pi's count; parts are estimates (about 4 characters a token).")}
				</span>
				<Button
					size="sm"
					disabled={busy || tokens <= 0}
					title={busy ? t("Finish the turn to compact") : t("Fold the conversation into a summary")}
					onClick={() => {
						onClose();
						onCompact();
					}}
				>
					{t("Compact")}
				</Button>
			</div>
		</div>
	);
}

/** The meter while a compaction runs: the turn's spinner, which is JS-driven so reduced motion does not freeze it. */
function Compacting() {
	const spinner = useSpinner(true, STAR_FRAMES, 120);
	const [start] = useState(Date.now);
	const [now, setNow] = useState(start);
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	return (
		<span
			data-custom="context meter"
			role="status"
			className="flex shrink-0 items-center gap-1.5 px-1 text-meta tabular-nums text-neutral-400"
		>
			<span aria-hidden className="w-3 text-center text-amber-400">
				{spinner}
			</span>
			{t("compacting {time}", { time: elapsed(now - start) })}
		</span>
	);
}

/** Claude Code's glyph cycle, there and back. */
// No ✳ (U+2733): it has emoji presentation and Windows draws it as a green
// square. Claude Code swaps it for `*` on Windows for the same reason; ours is
// ∗ (U+2217) because ASCII `*` sits at the top of the line, not the middle.
const STAR_FRAMES = ["·", "✢", "∗", "✶", "✻", "✽", "✻", "✶", "∗", "✢"];
/** Claude Code's spinner verbs. */
const VERBS = [
	"Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
	"Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
	"Cogitating", "Combobulating", "Computing", "Concocting", "Conjuring", "Considering",
	"Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
	"Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
	"Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
	"Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
	"Herding", "Honking", "Hustling", "Ideating", "Imagining", "Incubating", "Inferring",
	"Jiving", "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling",
	"Mustering", "Musing", "Noodling", "Percolating", "Perusing", "Philosophising",
	"Pondering", "Pontificating", "Processing", "Puttering", "Puzzling", "Reticulating",
	"Ruminating", "Scheming", "Schlepping", "Shimmying", "Shucking", "Simmering",
	"Smooshing", "Spelunking", "Spinning", "Stewing", "Sussing", "Synthesizing",
	"Thinking", "Tinkering", "Transmuting", "Unfurling", "Unravelling", "Vibing",
	"Wandering", "Whirring", "Wibbling", "Wizarding", "Working", "Wrangling",
];
const VERB_MS = 4000;
/** Russian stand-ins: the English list is wordplay that does not translate word for word. */
const VERBS_RU = [
	"Думаю", "Размышляю", "Соображаю", "Колдую", "Вычисляю", "Прикидываю", "Мозгую",
	"Кумекаю", "Варю", "Стряпаю", "Кручу", "Верчу", "Разбираюсь", "Копаю", "Творю",
	"Химичу", "Мастерю", "Собираю", "Взвешиваю", "Обдумываю", "Смекаю", "Шаманю",
	"Ворожу", "Паяю", "Настраиваю", "Распутываю", "Вникаю", "Сочиняю", "Выдумываю",
	"Перевариваю", "Шуршу", "Жонглирую", "Медитирую", "Созерцаю", "Выстраиваю",
];
const randomVerb = () => {
	const verbs = getLanguage() === "ru" ? VERBS_RU : VERBS;
	return verbs[Math.floor(Math.random() * verbs.length)];
};

/**
 * When the running turn was asked: the first user message after the last
 * assistant message that ended a turn (one with no tool calls). Undefined when
 * that message is not in the transcript yet, e.g. a slash command that became
 * a turn.
 */
export function turnStart(messages: PiMessage[]): number | undefined {
	let start: number | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && !m.blocks.some((b) => b.kind === "tool")) break;
		if (m.role === "user") start = m.timestamp;
	}
	return start;
}

/**
 * The live turn, as the last line of the transcript: a verb that changes
 * every few seconds and the elapsed time. Timed from the question, not from
 * mount, so a reload mid-turn does not restart the clock.
 * The folded tool line above it already names what is running.
 */
export function TurnStatus({ since }: { since: number | undefined }) {
	const spinner = useSpinner(true, STAR_FRAMES, 120);
	const [mounted] = useState(Date.now);
	const start = Math.min(since ?? mounted, mounted);
	const [now, setNow] = useState(mounted);
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	const secs = Math.floor((now - start) / 1000);
	const slot = Math.floor((now - start) / VERB_MS);
	const verb = useMemo(randomVerb, [slot]);
	return (
		<div className="chat-gutter my-3" role="status">
			<div className="chat-measure flex items-center gap-2 text-body text-neutral-500">
				<span aria-hidden className="w-4 text-center text-amber-400">
					{spinner}
				</span>
				<span>{verb}…</span>
				{secs > 0 && <span className="tabular-nums">{elapsed(now - start)}</span>}
			</div>
		</div>
	);
}

/** 75000 -> "1m 15s". */
function elapsed(ms: number): string {
	const secs = Math.floor(ms / 1000);
	return secs < 60 ? t("{s}s", { s: secs }) : t("{m}m {s}s", { m: Math.floor(secs / 60), s: secs % 60 });
}

/** What the bar under a turn's answer needs; see `rows` in Chat. */
export interface Footer {
	/** The answer's start timestamp: how the server finds it to fork. */
	at: number;
	endedAt?: number;
	/** When the question was asked: the turn's duration runs from here. */
	asked?: number;
}

/** Copy `text`; the icon swaps to a check for 1.2s. */
function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			// Clipboard API can be denied/unavailable; failing silently beats a crash.
		}
	};
	return (
		<IconButton size="sm" label={copied ? t("Copied") : t("Copy")} onClick={() => void copy()}>
			{copied ? <Check size={14} /> : <Copy size={14} />}
		</IconButton>
	);
}

/**
 * Under your prompt: copy it, edit it (disabled while a turn runs), and when it
 * was sent. The answer footer's shape, with Edit in Fork's place.
 */
function UserFooter({ text, at, onEdit }: { text: string; at?: number; onEdit?: () => void }) {
	return (
		<div className="chat-measure mt-1 flex items-center gap-1 text-meta text-neutral-500">
			<CopyButton text={text} />
			<IconButton size="sm" label={t("Edit")} disabled={!onEdit} onClick={onEdit}>
				<PencilSimple size={14} />
			</IconButton>
			{at !== undefined && (
				<span className="ml-1" title={new Date(at).toLocaleString(locale())}>
					{timeAgo(at)}
				</span>
			)}
		</div>
	);
}

/**
 * Under the answer that ends a turn: copy it, fork a new session from it,
 * when it was answered (exact time on hover) and how long the turn took.
 */
function AnswerFooter({
	footer,
	text,
	onFork,
}: {
	footer: Footer;
	text: string;
	onFork: (at: number) => Promise<void>;
}) {
	const [forking, setForking] = useState(false);
	const end = footer.endedAt ?? footer.at;
	const took = footer.endedAt && footer.asked ? footer.endedAt - footer.asked : 0;
	return (
		<div className="chat-measure mt-1 flex items-center gap-1 text-meta text-neutral-500">
			<CopyButton text={text} />
			<IconButton
				size="sm"
				label={forking ? t("Forking…") : t("Fork from here")}
				disabled={forking}
				onClick={() => {
					setForking(true);
					void onFork(footer.at).finally(() => setForking(false));
				}}
			>
				<GitFork size={14} />
			</IconButton>
			<span className="ml-1" title={new Date(end).toLocaleString(locale())}>
				{timeAgo(end)}
			</span>
			{took >= 1000 && <span className="tabular-nums">· {elapsed(took)}</span>}
		</div>
	);
}

/**
 * The line between one turn and the next, above your prompt, across the whole
 * pane (outside the gutter). Kept but invisible above the first prompt, so its
 * spacing stays.
 */
function TurnSeparator() {
	return <hr aria-hidden className="my-6 -ml-(--scrollbar) border-neutral-800 group-first/turn:invisible" />;
}

/**
 * The chrome every transcript row shares: the gutter, the speaker label, the
 * prose column. Shared by settled messages, a collapsed run of tool calls,
 * and the streaming row — three things that must line up exactly.
 *
 * What the user said gets a PILL instead: a rounded-sm card in the reading
 * column, the shape every chat client uses for the half of the conversation
 * you wrote. It replaced a full-bleed stripe, which at this measure was a
 * band of slightly different grey running the whole width of the window —
 * loud about the row and quiet about the words in it. The pill needs no
 * `USER` label either: nothing else in the transcript is shaped like it.
 */
export function TranscriptRow({
	role,
	labelled,
	children,
	below,
}: {
	role: PiMessage["role"];
	labelled: boolean;
	children: ReactNode;
	/** Under the pill (user, shown on hover) or under the answer (its footer). */
	below?: ReactNode;
}) {
	if (role === "user") {
		return (
			<div className="group/turn">
				<TurnSeparator />
				<div className="chat-gutter">
					{/* The composer's width: it overhangs the reading column by its padding. */}
					<div className="chat-measure">
						<div className="-mx-3 chat-prose rounded-lg bg-neutral-900 p-3 ring-1 ring-neutral-700 ring-inset">
							{children}
						</div>
					</div>
					{below}
				</div>
			</div>
		);
	}

	/*
	 * A continuation row carries NO vertical padding: its blocks already have
	 * margins, and padding on top of them made two tool calls sent as two
	 * messages sit twice as far apart as two tool calls inside one message —
	 * a gap that encodes nothing a reader can see or use.
	 */
	return (
		<div className={`chat-gutter ${labelled ? "pt-3" : ""}`}>
			{/* `chat-measure` on the LABEL too: it names the column it sits above,
			    so it has to move with it — left in the track while the prose is
			    centred put the speaker's name nowhere near their words. */}
			{labelled && role !== "assistant" && (
				<div className={`chat-measure mb-1 ${sectionLabel}`}>
					{role}
				</div>
			)}
			<div className={`chat-prose ${labelled ? "flow-trim-start" : ""} ${below ? "flow-trim-end" : ""}`}>
				{children}
			</div>
			{below}
		</div>
	);
}

/** One message row. See `rows` in Chat for where `labelled` and `footer` come from. */
export function Message({
	role,
	blocks,
	labelled,
	autoOpenTools,
	userMode,
	foldThinking,
	footer,
	onFork,
	at,
	onEdit,
}: {
	role: PiMessage["role"];
	blocks: PiBlock[];
	labelled: boolean;
	autoOpenTools: boolean;
	userMode: UserMode;
	foldThinking: boolean;
	footer?: Footer;
	onFork: (at: number) => Promise<void>;
	/** The message's start timestamp: how the server finds a user message to edit. */
	at?: number;
	/** Absent while a turn runs: pi cannot rewind under a running turn. */
	onEdit?: (at: number, text: string, images: PiImage[]) => void;
}) {
	const isUser = role === "user";
	const [editing, setEditing] = useState(false);
	/*
	 * In a pill the attachments go ON TOP, as one row of squares, whatever
	 * order they arrived in: a screenshot is context for the question, so it
	 * belongs above the question, and interleaving image blocks with the text
	 * that references them is how a two-line prompt becomes a screenful.
	 */
	const images = isUser ? blocks.filter((b) => b.kind === "image") : [];
	const rest = isUser ? blocks.filter((b) => b.kind !== "image") : blocks;
	const text = blocks
		.map((b) => (b.kind === "text" ? b.text : ""))
		.filter(Boolean)
		.join("\n\n");
	if (editing && onEdit && at !== undefined) {
		const attached = images.flatMap((b) => (b.kind === "image" ? [{ data: b.data, mimeType: b.mimeType }] : []));
		return (
			<EditMessage
				text={text}
				attached={attached}
				onCancel={() => setEditing(false)}
				onSend={(next, kept) => {
					setEditing(false);
					onEdit(at, next, kept);
				}}
			/>
		);
	}
	return (
		<TranscriptRow
			role={role}
			labelled={labelled}
			below={
				isUser ? (
					<UserFooter text={text} at={at} onEdit={onEdit && at !== undefined ? () => setEditing(true) : undefined} />
				) : footer ? (
					<AnswerFooter footer={footer} text={text} onFork={onFork} />
				) : undefined
			}
		>
			{images.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-2">
					{images.map((b, i) =>
						b.kind === "image" ? (
							<Thumb key={i} image={b} label={t("attachment {n}", { n: i + 1 })} />
						) : null,
					)}
				</div>
			)}
			{rest.map((b, i) => (
				<Block key={i} block={b} isUser={isUser} autoOpenTools={autoOpenTools} userMode={userMode} foldThinking={foldThinking} />
			))}
		</TranscriptRow>
	);
}

/**
 * A user message being edited, in the pill's place, drawn as the composer:
 * the same box, field and send button, plus Cancel. Sending drops everything
 * after it and asks again with the attachments that are left.
 */
function EditMessage({
	text,
	attached,
	onCancel,
	onSend,
}: {
	text: string;
	attached: PiImage[];
	onCancel: () => void;
	onSend: (text: string, images: PiImage[]) => void;
}) {
	const [draft, setDraft] = useState(text);
	const [images, setImages] = useState(attached);
	const canSend = draft.trim() !== "" || images.length > 0;
	return (
		<div className="group/turn">
			<TurnSeparator />
			<div className="chat-gutter">
			<div className="chat-measure">
				<div className="-mx-3 rounded-lg bg-neutral-900 p-3 ring-1 ring-neutral-700 ring-inset">
					<Attachments images={images} onRemove={(i) => setImages(images.filter((_, n) => n !== i))} />
					<textarea
						data-custom="composer"
						autoFocus
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onFocus={(e) => e.currentTarget.setSelectionRange(draft.length, draft.length)}
						onKeyDown={(e) => {
							if (e.key === "Escape") onCancel();
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								if (canSend) onSend(draft, images);
							}
						}}
						placeholder={t("Message pi…")}
						title={t("Enter to send, Shift+Enter for newline, Escape to cancel")}
						className="chat-prose field-sizing-content max-h-60 w-full resize-none bg-transparent outline-none placeholder:text-neutral-600"
					/>
					<div className="mt-4 flex items-center justify-end gap-1.5">
						<Button size="sm" onClick={onCancel}>
							{t("Cancel")}
						</Button>
						<IconButton
							onClick={() => onSend(draft, images)}
							disabled={!canSend}
							label={t("Send")}
							title={t("Send (Enter)")}
							variant="bare"
							size="sm"
							round
						>
							<PaperPlaneTilt size={24} className={canSend ? "text-neutral-100" : undefined} />
						</IconButton>
					</div>
				</div>
			</div>
			</div>
		</div>
	);
}

/**
 * The compaction boundary.
 *
 * Everything above it is out of the model's context; the summary is what
 * replaced it. Rendered as a divider rather than a message because nobody
 * SAID it — and collapsed, because the summary is the agent's notes to
 * itself, while the one thing a reader needs at a glance is that the line is
 * there at all.
 */
export function CompactionRow({ text }: { text: string }) {
	return (
		<details className="chat-gutter my-4">
			<summary className={`flex cursor-pointer list-none items-center gap-3 ${sectionLabel} select-none`}>
				<span className="h-px flex-1 bg-neutral-800" />
				{t("compacted — context starts here")}
				<span className="h-px flex-1 bg-neutral-800" />
			</summary>
			<div className="chat-prose mt-3">
				<MarkdownText text={text} />
			</div>
		</details>
	);
}

/** Per-level colors for a notice line. Info is deliberately quiet. */
const NOTICE_STYLE: Record<PiNotice["level"], string> = {
	info: "border-neutral-800 bg-neutral-900/60 text-neutral-300",
	warning: "border-amber-900 bg-amber-950/30 text-amber-300",
	error: "border-red-900 bg-red-950/40 text-red-300",
};

/**
 * What a local slash command answered.
 *
 * `/compact`, `/cost` and friends never append a message, so this is the
 * whole visible result of running one: without it a command looks like it did
 * nothing at all. Ephemeral by design — the next prompt clears it.
 */
export function Notices({ notices }: { notices: PiNotice[] }) {
	if (notices.length === 0) return null;
	return (
		<div className="chat-gutter my-3 space-y-2">
			{notices.map((n, i) => (
				<div
					key={i}
					className={`chat-measure rounded-sm border px-3 py-2 text-body whitespace-pre-wrap ${NOTICE_STYLE[n.level]}`}
				>
					{n.text}
				</div>
			))}
		</div>
	);
}

/**
 * A local slash command, echoed as the user row pi never writes.
 *
 * Two separate gaps, one row: a local command appends NO message, so the
 * `/compact remote` you typed vanished from the transcript the moment the box
 * cleared; and the prompt ack is acceptance and not completion, so nothing
 * said it was still going either. Ephemeral like the notice it belongs to —
 * the next prompt clears both.
 */
export function CommandRow({ command, running }: { command: string; running: boolean }) {
	const spinner = useSpinner(running);
	return (
		<TranscriptRow role="user" labelled>
			<div className="flex items-center gap-2">
				<span className="font-mono text-body">{command}</span>
				{running && (
					<span className="flex items-center gap-1.5 font-mono text-meta text-amber-400">
						<span>{spinner}</span>
						<span className="font-sans">{t("working…")}</span>
					</span>
				)}
			</div>
		</TranscriptRow>
	);
}
