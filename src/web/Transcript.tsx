import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaretDown, CaretRight, CaretUp, Check, Copy, GitFork, PencilSimple, X } from "@phosphor-icons/react";
import { AnsiHtml } from "fancy-ansi/react";
import { hasAnsi, stripAnsi } from "fancy-ansi";
import type { PiBlock, PiImage, PiMessage, PiNotice } from "../shared/types.js";
import { Button, IconButton, sectionLabel } from "./ui.js";
import { MarkdownText } from "./Markdown.js";
import { timeAgo } from "./SessionList.js";
import { Thumb } from "./Attachments.js";

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
	const firstLine = stripAnsi(result).split("\n", 1)[0]?.trim() ?? "";
	return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
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
		<div className="chat-wide my-1">
			<button
				data-custom="transcript disclosure"
				onClick={() => setOpen((o) => !o)}
				className={`flex items-center gap-1 font-mono text-body ${isError ? "text-red-400" : running ? "text-amber-400" : "text-neutral-500"} hover:text-neutral-300`}
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
				{preview && <span className="ml-1 font-normal text-neutral-600">{preview}</span>}
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
	bash: (n) => (n === 1 ? "ran a command" : `ran ${n} commands`),
	powershell: (n) => (n === 1 ? "ran a command" : `ran ${n} commands`),
	read: (n) => (n === 1 ? "read a file" : `read ${n} files`),
	edit: (n) => (n === 1 ? "edited a file" : `edited ${n} files`),
	write: (n) => (n === 1 ? "wrote a file" : `wrote ${n} files`),
	grep: (n) => (n === 1 ? "grepped" : `grepped ${n} times`),
	find: (n) => (n === 1 ? "found files" : `found files ${n} times`),
	ls: (n) => (n === 1 ? "listed a directory" : `listed ${n} directories`),
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
	if (phrases.length > shown.length) shown.push(`+${phrases.length - shown.length} more`);
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
					? "Thinking"
					: thoughts === 1
						? "Thought"
						: `Thought ${thoughts} times`
				: blocks.length === 1
					? "1 step"
					: `${blocks.length} steps`;
	return (
		<div className="chat-wide my-1">
			<button
				data-custom="transcript disclosure"
				onClick={() => setOpen((o) => !o)}
				className="flex items-center gap-1 font-mono text-body text-neutral-500 hover:text-neutral-300"
			>
				{open ? <CaretDown size={11} /> : <CaretRight size={11} />}
				{label}
				{/* No spinner while running: TurnStatus below already animates, and a
				    second one on a line that joins and splits between messages
				    flickered. */}
				{running ? null : failed > 0 ? (
					<span className="flex items-center gap-1 text-red-400">
						<X size={11} weight="bold" />
						{failed} failed
					</span>
				) : (
					<Check size={11} weight="bold" className="text-green-400" />
				)}
			</button>
			{open && (
				<div className="chat-nested mt-1 border-l border-neutral-800 pl-3">
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
}: {
	block: PiBlock;
	isUser: boolean;
	autoOpenTools: boolean;
}) {
	if (block.kind === "text")
		// No `chat-measure` on the user branch: the pill IS the column, and a
		// second centred box inside it would indent the text off its own edge.
		return isUser ? (
			<UserText text={block.text} />
		) : (
			<MarkdownText text={block.text} />
		);
	if (block.kind === "image")
		return (
			<img
				src={`data:${block.mimeType};base64,${block.data}`}
				alt="attachment"
				className="chat-wide my-2 max-h-80 rounded-sm border border-neutral-800"
			/>
		);
	if (block.kind === "thinking")
		return (
			<div className="chat-measure text-body whitespace-pre-wrap text-neutral-500 italic">
				{block.text}
			</div>
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
 * A user message clamped to 3 lines so a long prompt does not bury the
 * transcript. The toggle shows only when the clamp actually cuts text.
 */
function UserText({ text }: { text: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [overflows, setOverflows] = useState(false);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || open) return;
		const check = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
		check();
		const ro = new ResizeObserver(check);
		ro.observe(el);
		return () => ro.disconnect();
	}, [text, open]);
	return (
		<>
			<div ref={ref} className={`whitespace-pre-wrap ${open ? "" : "line-clamp-3"}`}>
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
					{open ? "Show less" : "Show more"}
				</Button>
			)}
		</>
	);
}

/** 312764 -> "313k". Tokens are never interesting to the digit. */
function compactTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

/**
 * How full the context is, next to the status line — and the only way to
 * compact from here.
 *
 * The number is pi's own `contextUsage` from `get_session_stats` (see
 * `fetchState` in src/server/agent.ts), not an estimate: it already counts
 * the system prompt, the tools and the cached prefix, which is exactly the
 * part a token count computed in the browser would miss and be wrong by, and
 * unlike the newest turn's `usage` it follows a compaction back down. It goes
 * amber at 75% and red at 90%, the band where the next long tool result
 * triggers a compaction.
 *
 * Clicking it compacts, because the meter is where you are already looking
 * when you decide to. Typing `/compact [instructions]` does the same: pi's own
 * `/compact` is TUI-only, so `send` in useSession.ts routes it here instead of to pi.
 */
export function ContextMeter({
	tokens,
	window: limit,
	busy,
	compacting,
	onCompact,
}: {
	tokens: number;
	window: number;
	busy: boolean;
	compacting: boolean;
	onCompact: () => void;
}) {
	if (limit <= 0 || tokens <= 0) return null;
	if (compacting) return <Compacting />;
	const share = Math.min(1, tokens / limit);
	const percent = Math.round(share * 100);
	const tone =
		share >= 0.9 ? "text-red-400" : share >= 0.75 ? "text-amber-400" : "text-neutral-500";
	return (
		<button
			data-custom="context meter"
			onClick={() => onCompact()}
			disabled={busy}
			title={
				busy
					? `${tokens.toLocaleString()} of ${limit.toLocaleString()} context tokens used — finish the turn to compact`
					: `${tokens.toLocaleString()} of ${limit.toLocaleString()} context tokens used. Click to compact the conversation into a summary.`
			}
			className={`flex shrink-0 items-center gap-1.5 rounded-sm px-1 text-meta tabular-nums transition-colors duration-150 ease-out enabled:hover:text-neutral-200 disabled:cursor-default motion-reduce:transition-none ${tone}`}
		>
			<span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-neutral-800">
				<span className="block h-full bg-current" style={{ width: `${percent}%` }} />
			</span>
			{compactTokens(tokens)}/{compactTokens(limit)}
			<span className="sr-only"> context tokens used; compact the conversation</span>
		</button>
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
			compacting {elapsed(now - start)}
		</span>
	);
}

/** Claude Code's glyph cycle, there and back. */
// No ✳ (U+2733): it has emoji presentation and Windows draws it as a green
// square. Claude Code swaps it for `*` on Windows for the same reason.
const STAR_FRAMES = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];
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
const randomVerb = () => VERBS[Math.floor(Math.random() * VERBS.length)];

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
		<div className="chat-gutter py-3" role="status">
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
	return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/** What the bar under a turn's answer needs; see `rows` in Chat. */
export interface Footer {
	/** The answer's start timestamp: how the server finds it to fork. */
	at: number;
	endedAt?: number;
	/** When the question was asked: the turn's duration runs from here. */
	asked?: number;
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
	const [copied, setCopied] = useState(false);
	const [forking, setForking] = useState(false);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1200);
		} catch {
			// Clipboard API can be denied/unavailable; failing silently beats a crash.
		}
	};
	const end = footer.endedAt ?? footer.at;
	const took = footer.endedAt && footer.asked ? footer.endedAt - footer.asked : 0;
	return (
		<div className="chat-measure mt-1 flex items-center gap-1 text-meta text-neutral-500">
			<IconButton size="sm" label={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
				{copied ? <Check size={14} /> : <Copy size={14} />}
			</IconButton>
			<IconButton
				size="sm"
				label={forking ? "Forking…" : "Fork from here"}
				disabled={forking}
				onClick={() => {
					setForking(true);
					void onFork(footer.at).finally(() => setForking(false));
				}}
			>
				<GitFork size={14} />
			</IconButton>
			<span className="ml-1" title={new Date(end).toLocaleString()}>
				{timeAgo(end)}
			</span>
			{took >= 1000 && <span className="tabular-nums">· {elapsed(took)}</span>}
		</div>
	);
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
	/** User rows only: actions under the pill, shown on hover. */
	below?: ReactNode;
}) {
	if (role === "user") {
		return (
			<div className="group chat-gutter py-2">
				<div className="chat-measure chat-prose rounded-lg bg-neutral-900 px-4 py-3">
					{children}
				</div>
				{below && (
					<div className="chat-measure mt-1 flex justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100">
						{below}
					</div>
				)}
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
			{labelled && (
				<div className={`chat-measure mb-1 ${sectionLabel}`}>
					{role}
				</div>
			)}
			<div className="chat-prose">{children}</div>
		</div>
	);
}

/** One message row. See `rows` in Chat for where `labelled` and `footer` come from. */
export function Message({
	role,
	blocks,
	labelled,
	autoOpenTools,
	footer,
	onFork,
	at,
	onEdit,
}: {
	role: PiMessage["role"];
	blocks: PiBlock[];
	labelled: boolean;
	autoOpenTools: boolean;
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
				onSend={(t) => {
					setEditing(false);
					onEdit(at, t, attached);
				}}
			/>
		);
	}
	return (
		<TranscriptRow
			role={role}
			labelled={labelled}
			below={
				isUser && onEdit && at !== undefined ? (
					<IconButton size="sm" label="Edit" onClick={() => setEditing(true)}>
						<PencilSimple size={14} />
					</IconButton>
				) : undefined
			}
		>
			{images.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-2">
					{images.map((b, i) =>
						b.kind === "image" ? (
							<Thumb key={i} image={b} label={`attachment ${i + 1}`} />
						) : null,
					)}
				</div>
			)}
			{rest.map((b, i) => (
				<Block key={i} block={b} isUser={isUser} autoOpenTools={autoOpenTools} />
			))}
			{footer && (
				<AnswerFooter footer={footer} text={text} onFork={onFork} />
			)}
		</TranscriptRow>
	);
}

/**
 * A user message being edited, in the pill's place. Sending drops everything
 * after it and asks again; the attachments go along unchanged.
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
	onSend: (text: string) => void;
}) {
	const [draft, setDraft] = useState(text);
	const canSend = draft.trim() !== "" || attached.length > 0;
	return (
		<div className="chat-gutter py-2">
			<div className="chat-measure rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3">
				{attached.length > 0 && (
					<div className="mb-2 flex flex-wrap gap-2">
						{attached.map((image, i) => (
							<Thumb key={i} image={image} label={`attachment ${i + 1}`} />
						))}
					</div>
				)}
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
							if (canSend) onSend(draft);
						}
					}}
					title="Enter to send, Shift+Enter for newline, Escape to cancel"
					className="chat-prose field-sizing-content max-h-60 w-full resize-none bg-transparent outline-none"
				/>
				<div className="mt-2 flex justify-end gap-2">
					<Button size="sm" onClick={onCancel}>
						Cancel
					</Button>
					<Button size="sm" variant="primary" disabled={!canSend} onClick={() => onSend(draft)}>
						Send
					</Button>
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
				compacted — context starts here
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
						<span className="font-sans">working…</span>
					</span>
				)}
			</div>
		</TranscriptRow>
	);
}
