import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import {
	ArrowDown,
	ArrowUp,
	CaretDown,
	CaretRight,
	Check,
	Plus,
	Square,
	X,
} from "@phosphor-icons/react";
import { AnsiHtml } from "fancy-ansi/react";
import { hasAnsi, stripAnsi } from "fancy-ansi";
import type {
	AskAnswer,
	PiAsk,
	PiBlock,
	PiImage,
	PiMessage,
	PiNotice,
	PiPartial,
	Snapshot,
} from "../shared/types.js";
import { ModelSelector } from "./ModelSelector.js";
import { GitActions } from "./GitActions.js";
import { MarkdownText } from "./Markdown.js";
import type { ToolMode } from "./prefs.js";
import { clearDraft, readDraft, writeDraftImages, writeDraftText } from "./drafts.js";
import { completionOptions, parseCompletion, type CommandOption } from "./commands.js";

/** Mirrors the server's allowlist; see SUPPORTED_IMAGE_MIME in agent.ts. */
const SUPPORTED_IMAGE_MIME = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/bmp",
];

/**
 * Read a clipboard/file blob into the wire shape.
 *
 * FileReader hands back a `data:` URL and we keep only the payload: the wire
 * contract is raw base64 (what the SDK's ImageContent wants), so the prefix is
 * stripped once, here, at the boundary where it appears.
 */
function readImage(file: File): Promise<PiImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(`could not read ${file.name || "image"}`));
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			if (comma < 0) return reject(new Error("unreadable image data"));
			resolve({ data: result.slice(comma + 1), mimeType: file.type });
		};
		reader.readAsDataURL(file);
	});
}

/**
 * Click-to-expand for every thumbnail on the page.
 *
 * A context and not a prop chain because the two places that show an image —
 * a sent message deep inside the transcript, and the composer's staging row —
 * have no common parent short of `Chat` itself, and threading a callback
 * through `Message`, `Block` and `ToolGroup` would put an image concern in
 * three components that otherwise have none.
 */
const ZoomContext = createContext<(src: string) => void>(() => {});

/**
 * One attachment, square.
 *
 * Square and small because an attachment is an ITEM in a list here, not
 * content: a screenshot rendered at its own aspect ratio pushes the message
 * it belongs to off the screen, and a row of mixed shapes is unreadable as a
 * set. `object-cover` crops to the square rather than letterboxing, so the
 * middle of the picture — which is what identifies it — stays visible; the
 * click is what shows the whole thing.
 */
function Thumb({
	image,
	label,
	onRemove,
}: {
	image: PiImage;
	label: string;
	onRemove?: () => void;
}) {
	const zoom = useContext(ZoomContext);
	const src = `data:${image.mimeType};base64,${image.data}`;
	return (
		<div className="group relative">
			<button
				onClick={() => zoom(src)}
				title="Click to expand"
				className="block size-14 overflow-hidden rounded-lg border border-neutral-700 transition-colors duration-150 ease-out hover:border-neutral-500 motion-reduce:transition-none"
			>
				<img src={src} alt={label} className="size-full object-cover" />
			</button>
			{onRemove && (
				<button
					onClick={onRemove}
					aria-label={`Remove ${label}`}
					className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-xs text-neutral-400 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 hover:text-neutral-100 focus:opacity-100 motion-reduce:transition-none"
				>
					<X size={13} />
				</button>
			)}
		</div>
	);
}

/**
 * The expanded image.
 *
 * A thumbnail is deliberately too small to read a screenshot in, so the full
 * size has to be one click away — and it is an overlay rather than a new tab
 * because the data is a base64 URL: a tab would show a megabyte of address
 * bar and, in some browsers, refuse to navigate to it at all.
 */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
	// Escape closes, because that is what every overlay in this app answers to
	// and because the click target (the backdrop) is not obvious.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Attachment"
			onClick={onClose}
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
		>
			{/* The image itself does not close on click: dragging to select or
			    right-clicking to save must not dismiss what you are looking at. */}
			<img
				src={src}
				alt="Attachment, full size"
				onClick={(e) => e.stopPropagation()}
				className="max-h-full max-w-full rounded border border-neutral-700 object-contain"
			/>
		</div>
	);
}

/** Staged attachments, above the composer until they are sent. */
function Attachments({
	images,
	onRemove,
}: {
	images: PiImage[];
	onRemove: (index: number) => void;
}) {
	if (images.length === 0) return null;
	return (
		<div className="mb-2 flex flex-wrap gap-2">
			{images.map((img, i) => (
				<Thumb
					key={i}
					image={img}
					label={`attachment ${i + 1}`}
					onRemove={() => onRemove(i)}
				/>
			))}
		</div>
	);
}

/**
 * How far from the bottom still counts as "at the bottom" — see `pinned` in
 * Chat. One line's worth: enough to absorb fractional device pixels and a
 * smooth scroll settling a pixel short, small enough that scrolling up to read
 * anything at all counts as having left.
 */
const PINNED_SLACK_PX = 24;

/** Braille spinner, same visual language as the TUI. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinner(active: boolean): string {
	const [i, setI] = useState(0);
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setI((v) => (v + 1) % SPINNER_FRAMES.length), 80);
		return () => clearInterval(id);
	}, [active]);
	return SPINNER_FRAMES[i];
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
function Tool({
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
				onClick={() => setOpen((o) => !o)}
				className={`flex items-center gap-1 font-mono text-sm ${isError ? "text-red-400" : running ? "text-amber-400" : "text-neutral-500"} hover:text-neutral-300`}
			>
				{open ? <CaretDown size={11} /> : <CaretRight size={11} />}
				{name}
				{running ? (
					<span>{spinner}</span>
				) : isError ? (
					<X size={11} weight="bold" />
				) : (
					<Check size={11} weight="bold" />
				)}
				{preview && <span className="ml-1 font-normal text-neutral-600">{preview}</span>}
			</button>
			{open && (
				<div className="chat-code mt-1 max-h-80 overflow-auto rounded bg-neutral-900 p-2 text-neutral-400">
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
 * the fact that something went wrong.
 */
function ToolGroup({ blocks }: { blocks: PiBlock[] }) {
	const [open, setOpen] = useState(false);
	const calls = blocks.filter((b): b is ToolBlock => b.kind === "tool");
	const running = calls.some((c) => c.result === undefined);
	const failed = calls.filter((c) => c.isError).length;
	const spinner = useSpinner(running);
	const tone =
		failed > 0 ? "text-red-400" : running ? "text-amber-400" : "text-neutral-500";
	const label =
		calls.length > 0
			? summarize(calls)
			: blocks.length === 1
				? "1 step"
				: `${blocks.length} steps`;
	return (
		<div className="chat-wide my-1">
			<button
				onClick={() => setOpen((o) => !o)}
				className={`flex items-center gap-1 font-mono text-sm ${tone} hover:text-neutral-300`}
			>
				{open ? <CaretDown size={11} /> : <CaretRight size={11} />}
				{label}
				{running ? (
					<span>{spinner}</span>
				) : failed > 0 ? (
					<span className="flex items-center gap-1">
						<X size={11} weight="bold" />
						{failed} failed
					</span>
				) : (
					<Check size={11} weight="bold" />
				)}
			</button>
			{open && (
				<div className="mt-1 border-l border-neutral-800 pl-3">
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
function Block({
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
			<div className="whitespace-pre-wrap">{block.text}</div>
		) : (
			<MarkdownText text={block.text} />
		);
	if (block.kind === "image")
		return (
			<img
				src={`data:${block.mimeType};base64,${block.data}`}
				alt="attachment"
				className="chat-wide my-2 max-h-80 rounded border border-neutral-800"
			/>
		);
	if (block.kind === "thinking")
		return (
			<div className="chat-measure text-sm whitespace-pre-wrap text-neutral-500 italic">
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
 * when you decide to: pi's own `/compact` is a TUI command and is not in the
 * catalog the composer offers, so without this a browser session can only
 * wait for the automatic fold at the threshold.
 */
function ContextMeter({
	tokens,
	window: limit,
	busy,
	onCompact,
}: {
	tokens: number;
	window: number;
	busy: boolean;
	onCompact: () => void;
}) {
	if (limit <= 0 || tokens <= 0) return null;
	const share = Math.min(1, tokens / limit);
	const percent = Math.round(share * 100);
	const tone =
		share >= 0.9 ? "text-red-400" : share >= 0.75 ? "text-amber-400" : "text-neutral-500";
	return (
		<button
			onClick={onCompact}
			disabled={busy}
			title={
				busy
					? `${tokens.toLocaleString()} of ${limit.toLocaleString()} context tokens used — finish the turn to compact`
					: `${tokens.toLocaleString()} of ${limit.toLocaleString()} context tokens used. Click to compact the conversation into a summary.`
			}
			className={`flex shrink-0 items-center gap-1.5 rounded font-mono text-xs transition-colors duration-150 ease-out enabled:hover:text-neutral-200 disabled:cursor-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-400 motion-reduce:transition-none ${tone}`}
		>
			<span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-neutral-800">
				<span className="block h-full bg-current" style={{ width: `${percent}%` }} />
			</span>
			{compactTokens(tokens)}/{compactTokens(limit)}
			<span className="sr-only"> context tokens used; compact the conversation</span>
		</button>
	);
}

/**
 * Persistent status line, pinned above the scrollable transcript.
 *
 * This is the thing a plain console gives you for free and a chat window
 * does not: at a glance, is it thinking, running a tool, writing, or done —
 * without scrolling to the bottom to find out. It reads directly off the
 * same partial state the transcript renders from, so it can never disagree
 * with what is on screen.
 */
function StatusLine({ busy, partial }: { busy: boolean; partial: PiPartial }) {
	const spinner = useSpinner(busy);

	if (!busy) {
		return (
			<div className="flex items-center gap-2 py-1.5 text-xs text-neutral-600">
				<span>○</span>
				<span>Idle</span>
			</div>
		);
	}

	const runningTool = [...partial.tools].reverse().find((t) => t.result === undefined);
	const label = runningTool
		? `Running ${runningTool.name}…`
		: partial.thinking && !partial.text
			? "Thinking…"
			: partial.text
				? "Writing response…"
				: "Waiting for model…";

	return (
		<div className="flex items-center gap-2 py-1.5 text-xs text-amber-400">
			<span className="font-mono">{spinner}</span>
			<span>{label}</span>
		</div>
	);
}

/**
 * The chrome every transcript row shares: the gutter, the speaker label, the
 * prose column. Shared by settled messages, a collapsed run of tool calls,
 * and the streaming row — three things that must line up exactly.
 *
 * What the user said gets a PILL instead: a rounded card in the reading
 * column, the shape every chat client uses for the half of the conversation
 * you wrote. It replaced a full-bleed stripe, which at this measure was a
 * band of slightly different grey running the whole width of the window —
 * loud about the row and quiet about the words in it. The pill needs no
 * `USER` label either: nothing else in the transcript is shaped like it.
 */
function TranscriptRow({
	role,
	labelled,
	children,
}: {
	role: PiMessage["role"];
	labelled: boolean;
	children: ReactNode;
}) {
	if (role === "user") {
		return (
			<div className="chat-gutter py-2">
				<div className="chat-measure chat-prose rounded-2xl bg-neutral-900 px-4 py-3">
					{children}
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
			{labelled && (
				<div className="chat-measure mb-1 text-[10px] tracking-wide text-neutral-500 uppercase">
					{role}
				</div>
			)}
			<div className="chat-prose">{children}</div>
		</div>
	);
}

/** One message row. See `rows` in Chat for where `labelled` comes from. */
function Message({
	role,
	blocks,
	labelled,
	autoOpenTools,
}: {
	role: PiMessage["role"];
	blocks: PiBlock[];
	labelled: boolean;
	autoOpenTools: boolean;
}) {
	const isUser = role === "user";
	/*
	 * In a pill the attachments go ON TOP, as one row of squares, whatever
	 * order they arrived in: a screenshot is context for the question, so it
	 * belongs above the question, and interleaving image blocks with the text
	 * that references them is how a two-line prompt becomes a screenful.
	 */
	const images = isUser ? blocks.filter((b) => b.kind === "image") : [];
	const rest = isUser ? blocks.filter((b) => b.kind !== "image") : blocks;
	return (
		<TranscriptRow role={role} labelled={labelled}>
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
		</TranscriptRow>
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
function CompactionRow({ text }: { text: string }) {
	return (
		<details className="chat-gutter my-4">
			<summary className="flex cursor-pointer list-none items-center gap-3 text-[10px] tracking-wide text-neutral-500 uppercase select-none">
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
function Notices({ notices }: { notices: PiNotice[] }) {
	if (notices.length === 0) return null;
	return (
		<div className="chat-gutter my-3 space-y-2">
			{notices.map((n, i) => (
				<div
					key={i}
					className={`chat-measure rounded border px-3 py-2 text-sm whitespace-pre-wrap ${NOTICE_STYLE[n.level]}`}
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
function CommandRow({ command, running }: { command: string; running: boolean }) {
	const spinner = useSpinner(running);
	return (
		<TranscriptRow role="user" labelled>
			<div className="flex items-center gap-2">
				<span className="font-mono text-sm">{command}</span>
				{running && (
					<span className="flex items-center gap-1.5 font-mono text-xs text-amber-400">
						<span>{spinner}</span>
						<span className="font-sans">working…</span>
					</span>
				)}
			</div>
		</TranscriptRow>
	);
}

/**
 * Text written for a terminal, made safe for a browser.
 *
 * A pi extension's dialogs carry Nerd Font glyphs — the radio marks in front
 * of a picker's options, U+F10C and friends. Those are PRIVATE USE
 * codepoints: they mean something only to a font the terminal has and the
 * browser does not, so every one of them renders as a tofu box. The trailing
 * space goes with the glyph, or each line would start with a stray indent.
 */
const GLYPHS = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]+[ \t]?/gu;

function plain(text: string): string {
	return text.replace(GLYPHS, "");
}

/**
 * The question pi is blocked on, put to the user.
 *
 * This is the `ask` tool's whole point and it used to be unreachable from a
 * browser: the host cancelled every blocking `extension_ui_request`, so the
 * tool call failed with "Ask tool was cancelled by the user" and the question
 * itself — the one thing the agent actually needed — was never shown.
 *
 * Rendered in the transcript rather than as a modal. A modal would have to be
 * dismissable to be honest about the agent still waiting, and a dismissed
 * question is a session stalled with nothing on screen saying why. Here it
 * sits where the answer belongs, under the work that led to it.
 *
 * `Cancel` is kept, and it is not a close button: it sends pi a real
 * cancellation, which fails the `ask` call and lets the turn end. That is the
 * only way out of a question the user does not want to answer, and hiding it
 * would leave the only escape hatch being to abort the turn.
 */
function AskPanel({
	ask,
	onAnswer,
}: {
	ask: PiAsk;
	onAnswer: (askId: string, answer: AskAnswer) => void;
}) {
	const [text, setText] = useState(ask.value ?? "");
	const field = useRef<HTMLTextAreaElement | null>(null);

	/*
	 * Remounted per question via the `key` at the call site, so this runs once
	 * per question: the field starts focused because answering is the only
	 * thing to do here, and a second question in a row must not inherit the
	 * previous one's draft.
	 */
	useEffect(() => {
		field.current?.focus();
	}, []);

	return (
		<div className="chat-gutter my-3">
			<div className="chat-measure rounded border border-amber-900/70 bg-amber-950/20 px-3 py-3">
				{/*
				 * The title is NOT a short label. The extension that asks composes
				 * it in the TUI's terms: the `editor` that follows a picker's
				 * "Other" carries the whole rendered picker — question, every
				 * option, its description, "Enter your response:" — as one
				 * multi-line string. Uppercasing that shouted a paragraph, and
				 * collapsing the newlines ran it into one line, so it is rendered
				 * as the text it is.
				 */}
				{ask.title && (
					<div className="text-sm whitespace-pre-wrap text-amber-200/90">
						{plain(ask.title)}
					</div>
				)}
				{ask.message && (
					<div className="mt-1 text-sm whitespace-pre-wrap text-neutral-200">
						{plain(ask.message)}
					</div>
				)}

				{ask.kind === "select" && (
					<div className="mt-3 space-y-1">
						{ask.options?.map((o) => (
							<button
								key={o.label}
								onClick={() => onAnswer(ask.id, { value: o.label })}
								className="block w-full rounded border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-left text-sm transition-colors duration-150 ease-out hover:border-amber-800 hover:bg-neutral-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-400 motion-reduce:transition-none"
							>
								<span className="text-neutral-100">{o.label}</span>
							</button>
						))}
					</div>
				)}

				{ask.kind === "confirm" && (
					<div className="mt-3 flex gap-2">
						<button
							onClick={() => onAnswer(ask.id, { confirmed: true })}
							className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-amber-400"
						>
							Yes
						</button>
						<button
							onClick={() => onAnswer(ask.id, { confirmed: false })}
							className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-900"
						>
							No
						</button>
					</div>
				)}

				{ask.kind === "text" && (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							onAnswer(ask.id, { value: text });
						}}
						className="mt-3"
					>
						<textarea
							ref={field}
							value={text}
							onChange={(e) => setText(e.target.value)}
							onKeyDown={(e) => {
								// Enter answers, as it does in the composer. A multiline
								// question (an `editor` dialog) needs newlines, so there it takes
								// the modifier that the composer uses for the opposite.
								if (e.key !== "Enter") return;
								if (ask.multiline && !(e.metaKey || e.ctrlKey)) return;
								if (!ask.multiline && e.shiftKey) return;
								e.preventDefault();
								onAnswer(ask.id, { value: text });
							}}
							rows={ask.multiline ? 5 : 2}
							className="w-full resize-none rounded border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-amber-800"
						/>
						<div className="mt-2 flex items-center gap-2">
							<button
								type="submit"
								className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-neutral-950 hover:bg-amber-400"
							>
								Answer
							</button>
							<span className="text-xs text-neutral-500">
								{ask.multiline ? "Ctrl+Enter to send" : "Enter to send"}
							</span>
						</div>
					</form>
				)}

				<button
					onClick={() => onAnswer(ask.id, { cancelled: true })}
					className="mt-3 text-xs text-neutral-500 hover:text-neutral-300"
				>
					Cancel — fails the tool call and ends the turn
				</button>
			</div>
		</div>
	);
}

/**
 * The slash-command picker, above the composer.
 *
 * Not a dialog: the CLI shows this list without taking the keyboard away, and
 * that is the whole point — you keep typing and the list narrows. A modal
 * would mean tabbing out of the box you are completing, and would put a
 * backdrop over the transcript you are writing about.
 *
 * Mouse-down rather than click to pick: click fires after blur, and the
 * composer losing focus mid-pick puts the caret nowhere.
 */
function CommandPicker({
	options,
	selected,
	onPick,
	onHover,
}: {
	options: CommandOption[];
	selected: number;
	onPick: (option: CommandOption) => void;
	onHover: (index: number) => void;
}) {
	const list = useRef<HTMLDivElement>(null);

	// Keyboard navigation has to drag the viewport with it, or arrowing past
	// the fold selects rows nobody can see. 45 commands is well past the fold.
	useEffect(() => {
		list.current?.children[selected]?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	return (
		<div
			ref={list}
			role="listbox"
			aria-label="Slash commands"
			className="mb-2 max-h-64 overflow-y-auto rounded border border-neutral-700 bg-neutral-900"
		>
			{options.map((o, i) => (
				<div
					key={o.insert}
					role="option"
					aria-selected={i === selected}
					onMouseMove={() => onHover(i)}
					onMouseDown={(e) => {
						e.preventDefault();
						onPick(o);
					}}
					className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm ${
						i === selected ? "bg-neutral-800" : ""
					}`}
				>
					<span className="font-mono text-neutral-100">{o.label}</span>
					{o.source && <span className="font-mono text-xs text-neutral-500">{o.source}</span>}
					{o.description && (
						<span className="truncate text-xs text-neutral-400">{o.description}</span>
					)}
				</div>
			))}
		</div>
	);
}

/**
 * A rendered transcript row: one message, or a run of tool calls collapsed
 * into one group. Only "grouped" tool mode ever produces the second kind.
 */
type Row =
	| {
			kind: "message";
			role: PiMessage["role"];
			blocks: PiBlock[];
			labelled: boolean;
	  }
	| { kind: "tools"; blocks: PiBlock[]; labelled: boolean };

export function Chat({
	snapshot,
	origin,
	partial,
	busy,
	opening,
	showThinking,
	toolMode,
	modelError,
	command,
	onAnswerAsk,
	onSend,
	onAbort,
	onModelChange,
	onThinkingChange,
	onCommandMenu,
	onCompact,
	onRestart,
}: {
	snapshot: Snapshot | null;
	/** Where this project's piw answers: "" for this page's own server, else a machine's origin with no trailing slash. */
	origin: string;
	partial: PiPartial;
	busy: boolean;
	/**
	 * A session is being opened and there is nothing to show yet. Separate
	 * from `busy` (which is "the agent is working"): this one means the
	 * transcript itself has not arrived.
	 */
	opening: boolean;
	/** Reasoning blocks are a setting; see prefs.ts. */
	showThinking: boolean;
	/** How much of a tool call to show; see prefs.ts. */
	toolMode: ToolMode;
	modelError?: string | null;
	/**
	 * The local slash command last sent, verbatim, and whether it is still
	 * working. pi appends no message for one, so this is the only record of
	 * it on screen; see App.tsx for its lifetime.
	 */
	command?: { text: string; running: boolean } | null;
	onSend: (text: string, images?: PiImage[]) => void;
	onAnswerAsk: (askId: string, answer: AskAnswer) => void;
	onAbort: () => void;
	onModelChange: (model: string) => void;
	onThinkingChange: (level: string) => void;
	/** The composer's `/` picker just opened; re-read the command catalog. */
	onCommandMenu: () => void;
	/** Fold the conversation into a summary. Refused while a turn is running. */
	onCompact: () => void;
	/** Replace this session's pi child so it sees newly installed packages. */
	onRestart: () => void;
}) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<PiImage[]>([]);
	const [attachError, setAttachError] = useState<string | null>(null);
	/** The expanded attachment, as a data URL, or null. See Lightbox. */
	const [zoomed, setZoomed] = useState<string | null>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	/**
	 * The staged images, readable synchronously. A paste is async (the blob has
	 * to be read), so two fast pastes both need the list as it is right now —
	 * and persisting a draft from inside a state updater would make the write a
	 * side effect of rendering.
	 */
	const staged = useRef<PiImage[]>([]);
	/**
	 * Whether the transcript is parked at its bottom, which is what decides
	 * whether new content scrolls the view. Slack because "at the bottom" is
	 * never exact: fractional device pixels, a smooth scroll settling a pixel
	 * short, and a reader who nudged the wheel once all still mean "bottom".
	 */
	const pinned = useRef(true);
	/**
	 * The same fact as `pinned`, in state rather than a ref, because the
	 * "jump to latest" button has to RENDER from it. `pinned` stays a ref: it
	 * is read inside the scroll handler on every frame of a stream, and a
	 * re-render per scroll event would cost more than the button is worth.
	 */
	const [atBottom, setAtBottom] = useState(true);
	const toBottom = () => {
		const el = viewport.current;
		if (!el) return;
		pinned.current = true;
		setAtBottom(true);
		el.scrollTop = el.scrollHeight;
	};
	/**
	 * Picker state. `selected` is an index into the current option list, and
	 * `dismissed` remembers an Escape: the panel must stay shut while the user
	 * finishes typing the command they already know the name of, and reopen
	 * only when the text changes again.
	 */
	const [selected, setSelected] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	const composer = useRef<HTMLTextAreaElement>(null);

	// Normalised in App.toSnapshot, so this is a plain boolean even against a
	// server too old to send it.
	const canAttach = snapshot?.supportsImages;

	/*
	 * Restore the composer for the session being shown — see drafts.ts. This is
	 * the ONLY place `text` and `images` are set from outside a user action, so
	 * a tab switch swaps composers and a reload lands on what was typed.
	 */
	const draftKey = snapshot?.id;
	useEffect(() => {
		if (!draftKey) return;
		const draft = readDraft(draftKey);
		setText(draft.text);
		setImages(draft.images);
		staged.current = draft.images;
		setAttachError(null);
	}, [draftKey]);

	/*
	 * The picker's contents, derived from the text rather than held in state:
	 * one source of truth means the panel cannot disagree with the box it is
	 * completing, and there is no open/close bookkeeping to get wrong.
	 */
	const completion = useMemo(() => parseCompletion(text), [text]);
	const options = useMemo(
		() => (completion ? completionOptions(snapshot?.commands ?? [], completion) : []),
		[completion, snapshot?.commands],
	);
	const pickerOpen = options.length > 0 && !dismissed;

	// A changed option list makes the old index meaningless — and keeping it
	// would accept a row the user never looked at.
	useEffect(() => setSelected(0), [text]);

	/*
	 * The moment the composer becomes a command word is the moment to ask the
	 * session what commands it has. Keyed on `completing` rather than on the
	 * text, so holding a `/` and typing a name is one request, not one per
	 * keystroke; the server-side half is cached for 30s on top of that.
	 */
	const completing = completion !== null;
	useEffect(() => {
		if (completing) onCommandMenu();
	}, [completing, onCommandMenu]);

	/*
	 * Follow the stream only while the reader is already AT the bottom.
	 *
	 * Scrolling up is how you read back through a run that is still going, and
	 * yanking the view down on every delta made that impossible: the transcript
	 * grows several times a second, so every attempt to inspect an earlier tool
	 * call was undone before it could be read. Being parked at the bottom is
	 * the only state in which "keep me at the bottom" is what the reader asked
	 * for.
	 *
	 * Tracked from the scroll event rather than measured here, because by the
	 * time this effect runs the new content has already grown the scroll height
	 * and the reader is no longer at the bottom by definition. The last scroll
	 * the USER made is the intent worth reading.
	 *
	 * The jump is instant, and that is what keeps the flag honest. A scroll
	 * event cannot say who caused it, so a SMOOTH follow un-pins itself: text
	 * arrives faster than the animation travels, the handler sees a gap well
	 * short of the bottom, reads it as the reader scrolling away, and following
	 * stops mid-stream. Landing exactly at the bottom means the event our own
	 * scroll produces re-states "still pinned" instead of contradicting it.
	 */
	useEffect(() => {
		// A different session opens at its latest turn, and resets the intent:
		// the previous one may well have been left scrolled up.
		pinned.current = true;
		const el = viewport.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [snapshot?.id]);

	useEffect(() => {
		const el = viewport.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [snapshot?.messages.length, partial.text, partial.thinking]);

	/**
	 * The transcript as it is actually rendered.
	 *
	 * Two passes in one: blocks the settings suppress are dropped — a filter
	 * rather than `display:none`, since a hidden subtree still costs the
	 * markdown render and still answers find-in-page — and a message left
	 * with no blocks is dropped with it rather than leaving an empty labelled
	 * row behind.
	 *
	 * `labelled` then marks only where the SPEAKER CHANGES. One agent turn is
	 * routinely a dozen messages of tool calls, and an ASSISTANT heading over
	 * every one of them announces a new speaker that never arrived — the
	 * label is worth reading precisely because it is not on every row.
	 *
	 * In "grouped" mode a run of consecutive tool calls becomes one row. The run
	 * SPANS messages, because that is the shape of a turn: a dozen one-call
	 * messages in a row is exactly what is worth collapsing.
	 *
	 * In "answer" mode the unit is the whole TURN, not the run: everything the
	 * assistant did between two user messages folds into one line, and only the
	 * prose the turn ENDED on stays. The end is what makes it the answer — the
	 * model stopped there — so it is found by peeling text blocks off the back
	 * of the turn, not by picking the longest or the first. A turn still
	 * streaming ends on a tool call, so it has no answer yet and folds whole.
	 *
	 * Computed before the empty-pane early return below, because a hook
	 * cannot run conditionally.
	 */
	const rows = useMemo(() => {
		const out: Row[] = [];
		/** The run being accumulated. Never non-empty outside "grouped" mode. */
		let pending: PiBlock[] = [];
		/** The turn being accumulated. Never non-empty outside "answer" mode. */
		let turn: PiBlock[] = [];

		const lastRole = (): PiMessage["role"] | undefined => {
			const last = out.at(-1);
			if (!last) return undefined;
			// A group is always the assistant's, so it breaks the label the same
			// way a message from the assistant does.
			return last.kind === "tools" ? "assistant" : last.role;
		};
		const flushGroup = () => {
			if (pending.length === 0) return;
			out.push({
				kind: "tools",
				blocks: pending,
				labelled: lastRole() !== "assistant",
			});
			pending = [];
		};
		/**
		 * One turn: the work as a single folded line, then its answer as prose.
		 *
		 * Trailing images stay with the answer — a screenshot the turn ended on
		 * is part of what it said — but nothing else is peeled: a thought after
		 * the last paragraph means the turn did not end on prose.
		 */
		const flushTurn = () => {
			if (turn.length === 0) return;
			let cut = turn.length;
			while (cut > 0 && (turn[cut - 1].kind === "text" || turn[cut - 1].kind === "image"))
				cut--;
			const work = turn.slice(0, cut);
			const answer = turn.slice(cut);
			turn = [];
			if (work.length > 0)
				out.push({
					kind: "tools",
					blocks: work,
					labelled: lastRole() !== "assistant",
				});
			if (answer.length > 0)
				out.push({
					kind: "message",
					role: "assistant",
					blocks: answer,
					labelled: lastRole() !== "assistant",
				});
		};

		for (const m of snapshot?.messages ?? []) {
			const blocks = m.blocks.filter(
				(b) =>
					(showThinking || b.kind !== "thinking") &&
					(toolMode !== "hidden" || b.kind !== "tool"),
			);
			if (blocks.length === 0) continue;

			if (toolMode === "answer") {
				// The assistant's blocks pile up until someone else speaks; see
				// flushTurn below for where the answer is split back out.
				if (m.role === "assistant") {
					turn.push(...blocks);
					continue;
				}
				flushTurn();
				out.push({
					kind: "message",
					role: m.role,
					blocks,
					labelled: lastRole() !== m.role,
				});
				continue;
			}

			if (toolMode !== "grouped") {
				out.push({
					kind: "message",
					role: m.role,
					blocks,
					labelled: lastRole() !== m.role,
				});
				continue;
			}

			/*
			 * Tool blocks are peeled off into the run, and reasoning joins a run
			 * already open — see ToolGroup for why it belongs there. Everything
			 * else stays a message row, and order is preserved on both sides: a
			 * paragraph after three calls ends the run and starts the next one.
			 */
			let run: PiBlock[] = [];
			const flushRun = () => {
				if (run.length === 0) return;
				out.push({
					kind: "message",
					role: m.role,
					blocks: run,
					labelled: lastRole() !== m.role,
				});
				run = [];
			};
			for (const b of blocks) {
				if (b.kind === "tool") {
					flushRun();
					pending.push(b);
				} else if (b.kind === "thinking" && pending.length > 0) {
					pending.push(b);
				} else {
					flushGroup();
					run.push(b);
				}
			}
			flushRun();
		}
		flushGroup();
		flushTurn();
		return out;
	}, [snapshot?.messages, showThinking, toolMode]);

	if (!snapshot) {
		return (
			<main className="flex flex-1 items-center justify-center text-sm text-neutral-500">
				{/*
				  Opening a session spawns a pi child and reads the whole
				  transcript, which on a big session or a Pi is seconds. Showing the
				  old session's messages while that happens made a click look like
				  it did nothing, so the pane blanks immediately and says what it is
				  waiting for.

				  The label fades in rather than appearing at once: a cached session
				  opens in tens of milliseconds, and a spinner that flashes for one
				  frame is worse than no spinner. CSS, not a timer, because this is
				  presentation and a state update per open is not.
				*/}
				{opening ? (
					<span className="opening-label">Opening session…</span>
				) : (
					"Select a session, or press + New."
				)}
			</main>
		);
	}

	/*
	 * Every composer mutation goes through these two, which keep the persisted
	 * draft in step with the state. Writing from an effect instead would race
	 * the restore above: on a tab switch the effect would run with the new
	 * session's key and the previous session's text, and copy one onto the
	 * other.
	 */
	const changeText = (value: string) => {
		setText(value);
		writeDraftText(snapshot.id, value);
		// Typing is a new question, so a dismissed picker gets another chance:
		// Escape hides the list for the text it was showing, not forever.
		setDismissed(false);
	};

	/**
	 * Take a row. The whole composer is the command being completed, so the
	 * option replaces all of it — and accepting always leaves a trailing
	 * space, which is what turns `/fast` into the state that offers `on`,
	 * `off`, `status`.
	 */
	const accept = (option: CommandOption) => {
		changeText(option.insert);
		composer.current?.focus();
	};
	/** False when the attachments are staged but too big to persist as a draft. */
	const changeImages = (next: PiImage[]): boolean => {
		staged.current = next;
		setImages(next);
		return writeDraftImages(snapshot.id, next);
	};

	/**
	 * Ingest images from a paste or a file picker.
	 *
	 * Screenshot paste is the motivating case: the clipboard carries one
	 * `image/png` item and no filename. Non-image items are ignored rather than
	 * rejected, because pasting text that happens to travel alongside an image
	 * flavor must keep behaving like an ordinary paste.
	 */
	const addFiles = async (files: File[]) => {
		const picked = files.filter((f) => f.type.startsWith("image/"));
		if (picked.length === 0) return false;

		if (!canAttach) {
			setAttachError("This model does not accept images. Switch models to attach one.");
			return true;
		}

		const rejected = picked.filter((f) => !SUPPORTED_IMAGE_MIME.includes(f.type));
		const accepted = picked.filter((f) => SUPPORTED_IMAGE_MIME.includes(f.type));

		try {
			const read = await Promise.all(accepted.map(readImage));
			const kept = read.length === 0 || changeImages([...staged.current, ...read]);
			/*
			 * Both are worth saying, and neither is fatal: the rejected types were
			 * dropped, and images that did not fit in storage are still attached
			 * and still send — they just will not come back after a reload, which
			 * is better said than silently promised.
			 */
			const problems = [
				rejected.length > 0
					? `Unsupported image type: ${[...new Set(rejected.map((f) => f.type))].join(", ")}`
					: null,
				kept ? null : "Attached, but too large to keep if the page reloads.",
			].filter((p): p is string => p !== null);
			setAttachError(problems.length > 0 ? problems.join(" ") : null);
		} catch (err) {
			setAttachError(err instanceof Error ? err.message : String(err));
		}
		return true;
	};

	const submit = () => {
		const t = text.trim();
		// An image on its own is a valid prompt; only block when nothing is staged.
		if (!t && images.length === 0) return;
		onSend(t, images.length > 0 ? images : undefined);
		setText("");
		setImages([]);
		staged.current = [];
		clearDraft(snapshot.id);
		setAttachError(null);
	};

	// A suppressed block does not count toward "there is something to show",
	// or hiding it would leave a bare `assistant` label hanging in the
	// transcript for the whole reasoning or tool phase.
	const showTools = toolMode !== "hidden";
	/**
	 * Both folding modes collapse a streaming run into the one growing line.
	 * Live reasoning is NOT folded even in "answer" mode: while the turn runs,
	 * the thought is the only thing saying what it is doing, and it folds away
	 * by itself when the turn settles into rows.
	 */
	const folds = toolMode === "grouped" || toolMode === "answer";
	const hasPartial =
		partial.text ||
		(showThinking && partial.thinking) ||
		(showTools && partial.tools.length > 0);


	// The streaming block is one more assistant row, so it follows the same
	// rule: label it only when the last settled row was someone else. A
	// collapsed run of calls is the assistant's too.
	const lastRow = rows.at(-1);
	const partialLabelled =
		!lastRow || (lastRow.kind === "message" && lastRow.role !== "assistant");

	return (
		/*
		 * `min-h-0` twice, and it is load-bearing: a flex item defaults to
		 * `min-height: auto`, so without it this column grows to fit the whole
		 * transcript instead of being clipped to the panel, the inner
		 * `overflow-y-auto` never has anything to scroll, and the DOCUMENT
		 * scrolls instead — taking the session list and the composer with it.
		 */
		<ZoomContext.Provider value={setZoomed}>
			<main className="flex min-h-0 flex-1 flex-col">
				{/* The rows own their top spacing; the last one needs a floor under
			    it, and the scroll container is the only thing that knows which
			    row that is. */}
				<div
					ref={viewport}
					onScroll={(e) => {
						const el = e.currentTarget;
						const bottom =
							el.scrollHeight - el.scrollTop - el.clientHeight <= PINNED_SLACK_PX;
						pinned.current = bottom;
						// Only on a CHANGE: the setter is called for every scroll event
						// otherwise, which React would coalesce but still has to diff.
						setAtBottom((was) => (was === bottom ? was : bottom));
					}}
					className="min-h-0 flex-1 overflow-y-auto pb-3"
				>
					{rows.map((r, i) =>
						r.kind === "tools" ? (
							<TranscriptRow key={i} role="assistant" labelled={r.labelled}>
								<ToolGroup blocks={r.blocks} />
							</TranscriptRow>
						) : r.role === "compaction" ? (
							<CompactionRow
								key={i}
								text={r.blocks
									.map((b) => (b.kind === "text" ? b.text : ""))
									.join("\n")
									.trim()}
							/>
						) : (
							<Message
								key={i}
								role={r.role}
								blocks={r.blocks}
								labelled={r.labelled}
								autoOpenTools={toolMode === "live"}
							/>
						),
					)}

					{hasPartial && (
						<TranscriptRow role="assistant" labelled={partialLabelled}>
							{showThinking && partial.thinking && (
								<div className="chat-measure text-sm whitespace-pre-wrap text-neutral-500 italic">
									{partial.thinking}
								</div>
							)}
							{/*
							 * Grouped while it streams, not just once it settles: the group
							 * line grows in place instead of the pane growing a line per
							 * call, and the status line below still names the running tool.
							 */}
							{showTools && folds && partial.tools.length > 0 && (
								<ToolGroup blocks={partial.tools.map((t) => ({ kind: "tool", ...t }))} />
							)}
							{showTools &&
								!folds &&
								partial.tools.map((t) => (
									<Tool
										key={t.id}
										name={t.name}
										isError={t.isError}
										result={t.result}
										args={t.args}
										autoOpen={toolMode === "live"}
									/>
								))}
							{/* optimizeForStreaming suppresses incomplete inline syntax (an
						    unclosed ** or a half-typed fence) instead of rendering the raw
						    markers until the closing delimiter arrives next delta. */}
							{partial.text && <MarkdownText text={partial.text} streaming />}
						</TranscriptRow>
					)}

					{/* Below the transcript: a local command answers after the last
				    message, and before the next prompt clears it. */}
					{command && <CommandRow command={command.text} running={command.running} />}

					<Notices notices={snapshot.notices} />

					{/* Last, under the work that led to it: the agent is stopped here
				    until this is answered. Keyed so a second question does not
				    inherit the first one's typed draft. */}
					{snapshot.ask && (
						<AskPanel key={snapshot.ask.id} ask={snapshot.ask} onAnswer={onAnswerAsk} />
					)}

					{/* Errors are visible in the chat, never only in stderr. */}
					{snapshot.error && (
						<div className="chat-gutter my-3">
							<div className="chat-measure rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
								{snapshot.error}
							</div>
						</div>
					)}

					{/*
					 * A package was installed after this child started. pi reads
					 * extensions, skills and prompt templates once, at startup, so
					 * this session cannot see it until the process is replaced —
					 * which is offered, never done automatically, because a restart
					 * mid-turn would lose the turn.
					 */}
					{snapshot.stale && (
						<div className="chat-gutter my-3">
							<div className="chat-measure flex items-center gap-3 rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
								<span className="min-w-0 flex-1">
									Packages changed since this session started. Its commands and skills are the
									old set until it restarts.
								</span>
								<button
									onClick={onRestart}
									disabled={busy}
									title={
										busy
											? "Finish the turn first — a restart mid-turn loses it"
											: "Replace this session's pi process; the conversation is kept"
									}
									className="shrink-0 rounded border border-amber-800 px-2 py-0.5 text-xs transition-colors duration-150 ease-out enabled:hover:bg-amber-900/40 disabled:opacity-50 motion-reduce:transition-none"
								>
									Restart session
								</button>
							</div>
						</div>
					)}
				</div>

				{/*
				 * Status, context meter and git sit in the READING column, not the
				 * wide track, and no rule separates them from the transcript: the
				 * composer is the bottom of the chat, not a panel docked under it.
				 * A border here drew exactly that second panel.
				 */}
				<div className="chat-gutter py-2">
					<div className="chat-measure flex items-center justify-between gap-2">
						<div className="flex min-w-0 items-center gap-3">
							<StatusLine busy={busy} partial={partial} />
							<ContextMeter
								tokens={snapshot.contextTokens}
								window={snapshot.contextWindow}
								busy={busy}
								onCompact={onCompact}
							/>
						</div>
						{/*
						 * Git on the right of the status line and ABOVE the composer,
						 * which is where it belongs in the flow: you finish reading the
						 * turn, then you commit it. `onDone` refetches nothing here —
						 * the button owns its own state — but a commit does change the
						 * transcript's context, so the caller gets a hook.
						 */}
						<div className="flex shrink-0 items-center gap-2">
							{snapshot.cwd && <GitActions cwd={snapshot.cwd} origin={origin} />}
							{/* Jump to the newest message. Only while scrolled away from it:
						    a button that does nothing is worse than no button. */}
							{!atBottom && (
								<button
									onClick={toBottom}
									aria-label="Jump to the latest message"
									title="Jump to the latest message"
									className="flex size-7 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-300 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-100 motion-reduce:transition-none"
								>
									<ArrowDown size={14} />
								</button>
							)}
						</div>
					</div>
				</div>
				<div className="chat-gutter pt-1 pb-3">
					{/* Same column as the prose above it, so the box's edges line up
					    with the text you are replying to. */}
					<div className="chat-measure">
						{pickerOpen && (
							<CommandPicker
								options={options}
								selected={selected}
								onPick={accept}
								onHover={setSelected}
							/>
						)}

						{/*
						 * One box, the way every current chat client draws it: staged
						 * attachments on top, the field under them, and the controls on a
						 * bottom row inside the same border — attach and the model on the
						 * left, send on the right. The thumbnails used to sit ABOVE the
						 * box and the model selector above that, which read as three
						 * widgets that happened to be adjacent rather than as one thing
						 * you are about to send.
						 */}
						<div className="rounded-2xl border border-neutral-800 bg-neutral-900 px-3 py-2 focus-within:border-neutral-700">
							<Attachments
								images={images}
								onRemove={(i) => void changeImages(images.filter((_, n) => n !== i))}
							/>

							{attachError && (
								<div className="mb-2 text-xs text-red-400">{attachError}</div>
							)}

							<textarea
								ref={composer}
								value={text}
								onChange={(e) => changeText(e.target.value)}
								/*
								 * Ctrl+V never reaches onKeyDown as an intercept point worth using:
								 * clipboard contents are only available on the paste event itself
								 * (and reading them any other way needs a permission prompt). So we
								 * listen for paste, which also covers Cmd+V, middle-click paste and
								 * the context menu for free.
								 *
								 * preventDefault ONLY when an image was actually consumed, so a
								 * normal text paste is left completely untouched.
								 */
								onPaste={(e) => {
									const files = Array.from(e.clipboardData.files);
									if (!files.some((f) => f.type.startsWith("image/"))) return;
									e.preventDefault();
									void addFiles(files);
								}}
								onDragOver={(e) => e.preventDefault()}
								onDrop={(e) => {
									const files = Array.from(e.dataTransfer.files);
									if (!files.some((f) => f.type.startsWith("image/"))) return;
									e.preventDefault();
									void addFiles(files);
								}}
								onKeyDown={(e) => {
									/*
									 * The picker owns these keys while it is open, and only then:
									 * Enter takes the highlighted command instead of sending the
									 * half-typed name, Tab completes, Escape hides the list. The
									 * arrows move the highlight rather than the caret, which is
									 * free — the text is one line by the time the picker is up.
									 */
									if (pickerOpen) {
										if (e.key === "ArrowDown") {
											e.preventDefault();
											setSelected((s) => (s + 1) % options.length);
											return;
										}
										if (e.key === "ArrowUp") {
											e.preventDefault();
											setSelected((s) => (s - 1 + options.length) % options.length);
											return;
										}
										if (e.key === "Escape") {
											e.preventDefault();
											setDismissed(true);
											return;
										}
										if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
											e.preventDefault();
											const option = options[selected];
											/*
											 * The name is already typed in full and the row would
											 * only add its trailing space: `/compact` + Enter has to
											 * RUN `/compact`, not cost a second Enter. Tab still
											 * completes, which is how you get to the subcommands.
											 */
											if (e.key === "Enter" && option?.insert === `${text} `) {
												submit();
												return;
											}
											if (option) accept(option);
											return;
										}
									}
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										submit();
									}
								}}
								rows={3}
								placeholder={
									canAttach
										? "Enter to send, Shift+Enter for newline, Ctrl+V to paste a screenshot"
										: "Enter to send, Shift+Enter for newline"
								}
								// Transparent and borderless: the BOX is the control now, and a
								// second inset panel inside it was two edges for one field.
								className="chat-prose w-full resize-none bg-transparent outline-none placeholder:text-neutral-600"
							/>

							{/* Attach and the model on the left, send on the right. */}
							<div className="mt-1 flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-1.5">
									{canAttach && (
										<>
											<button
												onClick={() => fileInput.current?.click()}
												aria-label="Attach an image"
												title="Attach an image"
												className="flex size-7 shrink-0 items-center justify-center rounded-full border border-neutral-700 text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-100 motion-reduce:transition-none"
											>
												<Plus size={14} />
											</button>
											<input
												ref={fileInput}
												type="file"
												accept={SUPPORTED_IMAGE_MIME.join(",")}
												multiple
												className="hidden"
												onChange={(e) => {
													void addFiles(Array.from(e.target.files ?? []));
													// Reset so picking the SAME file twice still fires onChange.
													e.target.value = "";
												}}
											/>
										</>
									)}
									<ModelSelector
										model={snapshot.model}
										origin={origin}
										disabled={busy}
										error={modelError}
										onChange={onModelChange}
										thinkingLevel={snapshot.thinkingLevel}
										thinkingLevels={snapshot.thinkingLevels}
										onThinkingChange={onThinkingChange}
									/>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									{busy && (
										<button
											onClick={onAbort}
											aria-label="Stop"
											title="Stop this turn"
											className="flex size-7 items-center justify-center rounded-full border border-neutral-700 text-neutral-400 transition-colors duration-150 ease-out hover:bg-neutral-800 hover:text-neutral-100 motion-reduce:transition-none"
										>
											<Square size={11} weight="fill" />
										</button>
									)}
									<button
										onClick={submit}
										aria-label="Send"
										title="Send (Enter)"
										// `neutral-200` and not `white`: under a light theme the button
										// is dark text on a light page, and hovering to white would
										// erase it. One step along the ramp moves in a useful direction
										// whichever way the theme runs.
										className="flex size-7 items-center justify-center rounded-full bg-neutral-100 text-neutral-900 transition-colors duration-150 ease-out hover:bg-neutral-200 motion-reduce:transition-none"
									>
										<ArrowUp size={14} weight="bold" />
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>

				{/* Last, so it paints over everything: an expanded attachment. */}
				{zoomed && <Lightbox src={zoomed} onClose={() => setZoomed(null)} />}
			</main>
		</ZoomContext.Provider>
	);
}
