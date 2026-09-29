import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, QuestionMark, Square } from "@phosphor-icons/react";
import type {
	AskAnswer,
	PiBlock,
	PiCommand,
	PiImage,
	PiMessage,
	PiPartial,
	Snapshot,
} from "../shared/types.js";
import { Button, IconButton } from "./ui.js";
import { ModelSelector } from "./ModelSelector.js";
import { GitActions } from "./GitActions.js";
import { MarkdownText } from "./Markdown.js";
import type { ThinkingMode, ToolMode, UserMode } from "./prefs.js";
import { clearDraft, readDraft, writeDraftImages, writeDraftText } from "./drafts.js";
import { completionOptions, parseCompletion, type CommandOption } from "./commands.js";
import { AskPanel } from "./AskPanel.js";
import {
	Attachments,
	Lightbox,
	SUPPORTED_IMAGE_MIME,
	ZoomContext,
	readImage,
	uploadFile,
} from "./Attachments.js";
import {
	CommandRow,
	CompactionRow,
	ContextMeter,
	ContextPanel,
	Footer,
	Message,
	Notices,
	Reasoning,
	Thought,
	Tool,
	ToolGroup,
	TranscriptRow,
	TurnStatus,
	turnStart,
} from "./Transcript.js";
import { t } from "./i18n.js";

/** pi's `get_commands` omits its TUI-only `/compact`; `send` in useSession.ts runs it. */
const COMPACT_COMMAND: PiCommand = {
	name: "compact",
	get description() {
		return t("Summarise older messages to free context (optional: focus instructions)");
	},
	source: "pwi",
};

/**
 * How far from the bottom still counts as "at the bottom" — see `pinned` in
 * Chat. One line's worth: enough to absorb fractional device pixels and a
 * smooth scroll settling a pixel short, small enough that scrolling up to read
 * anything at all counts as having left.
 */
const PINNED_SLACK_PX = 24;

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
			aria-label={t("Slash commands")}
			className="mb-2 max-h-64 overflow-y-auto rounded-sm border border-neutral-700 bg-neutral-900"
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
					className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-ui ${
						i === selected ? "bg-neutral-800" : ""
					}`}
				>
					<span className="font-mono text-neutral-100">{o.label}</span>
					{o.source && <span className="font-mono text-meta text-neutral-500">{o.source}</span>}
					{o.description && (
						<span className="fade-end text-meta text-neutral-400">{o.description}</span>
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
			footer?: Footer;
			/** The message's start timestamp; see `at` on Message. */
			at?: number;
	  }
	| { kind: "tools"; blocks: PiBlock[]; labelled: boolean };

export function Chat({
	snapshot,
	partial,
	busy,
	opening,
	thinkingMode,
	toolMode,
	userMode,
	modelError,
	command,
	onAnswerAsk,
	onSend,
	onAbort,
	onModelChange,
	onThinkingChange,
	onCommandMenu,
	onCompact,
	compacting,
	onFork,
	onEdit,
	onRestart,
	draftRev = 0,
	focus,
}: {
	snapshot: Snapshot | null;
	partial: PiPartial;
	busy: boolean;
	/**
	 * A session is being opened and there is nothing to show yet. Separate
	 * from `busy` (which is "the agent is working"): this one means the
	 * transcript itself has not arrived.
	 */
	opening: boolean;
	/** Reasoning blocks are a setting; see prefs.ts. */
	thinkingMode: ThinkingMode;
	/** How much of a tool call to show; see prefs.ts. */
	toolMode: ToolMode;
	/** How long user messages fold; see prefs.ts. */
	userMode: UserMode;
	modelError?: string | null;
	/**
	 * The local slash command last sent, verbatim, and whether it is still
	 * working. pi appends no message for one, so this is the only record of
	 * it on screen; see useSession.ts for its lifetime.
	 */
	command?: { text: string; running: boolean } | null;
	onSend: (text: string, images?: PiImage[], askOnly?: boolean) => void;
	onAnswerAsk: (askId: string, answer: AskAnswer) => void;
	onAbort: () => void;
	onModelChange: (model: string) => void;
	onThinkingChange: (level: string) => void;
	/** The composer's `/` picker just opened; re-read the command catalog. */
	onCommandMenu: () => void;
	/** Fold the conversation into a summary. Refused while a turn is running. */
	onCompact: (instructions?: string) => void;
	/** A compaction started here is running. */
	compacting: boolean;
	/** Open a new session that continues from the answer that started at `at`. */
	onFork: (at: number) => Promise<void>;
	/** Replace the user message that started at `at` and ask again from there. */
	onEdit: (at: number, text: string, images: PiImage[]) => void;
	/** Replace this session's pi child so it sees newly installed packages. */
	onRestart: () => void;
	/**
	 * Bumped when App wrote this session's draft (Explorer's "Add to Chat"):
	 * re-read it and put the caret at its end.
	 */
	draftRev?: number;
	/** Bumped when the session list picked `entry`: focus the composer once it shows. */
	focus?: { entry: string; n: number };
}) {
	const showThinking = thinkingMode !== "hidden";
	const [text, setText] = useState("");
	// Sticky until switched off or the session changes: a run of questions is the usual case.
	const [askOnly, setAskOnly] = useState(false);
	const [images, setImages] = useState<PiImage[]>([]);
	const [attachError, setAttachError] = useState<string | null>(null);
	/** The expanded attachment, as a data URL, or null. See Lightbox. */
	const [zoomed, setZoomed] = useState<string | null>(null);
	const [contextOpen, setContextOpen] = useState(false);
	const closeContext = useCallback(() => setContextOpen(false), []);
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

	// Normalised in toSnapshot (useSession.ts), so this is a plain boolean even against a
	// server too old to send it.
	const canAttach = snapshot?.supportsImages;

	/*
	 * Restore the composer for the session being shown — see drafts.ts. This is
	 * the ONLY place `text` and `images` are set from outside a user action, so
	 * a tab switch swaps composers and a reload lands on what was typed.
	 */
	const draftKey = snapshot?.id;
	const seenRev = useRef(draftRev);
	const seenKey = useRef(draftKey);
	useEffect(() => {
		if (!draftKey) return;
		const draft = readDraft(draftKey);
		setText(draft.text);
		const sameSession = seenKey.current === draftKey;
		seenKey.current = draftKey;
		// An insert, not a session switch: the rest of the composer stays.
		if (sameSession && draftRev !== seenRev.current) {
			seenRev.current = draftRev;
			if (draftRev === 0) return;
			const el = composer.current;
			el?.focus();
			el?.setSelectionRange(draft.text.length, draft.text.length);
			return;
		}
		seenRev.current = draftRev;
		setImages(draft.images);
		staged.current = draft.images;
		setAttachError(null);
		setAskOnly(false);
	}, [draftKey, draftRev]);

	const seenFocus = useRef(focus?.n);
	useEffect(() => {
		if (!focus || !snapshot || focus.n === seenFocus.current) return;
		if (focus.entry !== snapshot.file && focus.entry !== snapshot.id) return;
		seenFocus.current = focus.n;
		composer.current?.focus();
	}, [focus, snapshot]);

	/*
	 * The picker's contents, derived from the text rather than held in state:
	 * one source of truth means the panel cannot disagree with the box it is
	 * completing, and there is no open/close bookkeeping to get wrong.
	 */
	const completion = useMemo(() => parseCompletion(text), [text]);
	const options = useMemo(
		() =>
			completion ? completionOptions([COMPACT_COMMAND, ...(snapshot?.commands ?? [])], completion) : [],
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
	 * A call settles into the transcript with the message that made it, then
	 * shows up in `partial.tools` once it starts running. Rendering both drew
	 * the call twice and bumped the fold's count by one until its result
	 * settled. So a live call's output goes onto its settled row, and only
	 * calls not yet in the transcript stay in the partial.
	 */
	const { messages, liveTools } = useMemo(() => {
		const settled = snapshot?.messages ?? [];
		if (partial.tools.length === 0) return { messages: settled, liveTools: partial.tools };
		const live = new Map(partial.tools.map((t) => [t.id, t]));
		const seen = new Set<string>();
		const merged = settled.map((m) => {
			let changed = false;
			const blocks = m.blocks.map((b) => {
				if (b.kind !== "tool") return b;
				seen.add(b.id);
				const t = live.get(b.id);
				if (!t || b.result !== undefined) return b;
				changed = true;
				return { ...b, result: t.result, isError: t.isError };
			});
			return changed ? { ...m, blocks } : m;
		});
		return { messages: merged, liveTools: partial.tools.filter((t) => !seen.has(t.id)) };
	}, [snapshot?.messages, partial.tools]);

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
		/** The last question's timestamp, for the footer's duration. */
		let asked: number | undefined;
		/** The accumulated turn's footer, set by its last assistant message. */
		let turnFooter: Footer | undefined;
		/**
		 * The footer goes under the message that ENDED a turn: an assistant
		 * message with no tool calls, the same rule as `turnStart`. Intermediate
		 * steps get none, so there is one per question.
		 */
		const footerFor = (m: PiMessage): Footer | undefined =>
			m.role === "assistant" && !m.blocks.some((b) => b.kind === "tool")
				? { at: m.timestamp, endedAt: m.endedAt, asked }
				: undefined;

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
		const flushTurn = (live = false) => {
			if (turn.length === 0) return;
			let cut = turn.length;
			// Mid-turn, prose is never the answer yet: splitting it out made each
			// paragraph pop out of the fold and back in when the next call came.
			// Only the running turn: finished turns keep their answers on screen.
			while (!live && cut > 0 && (turn[cut - 1].kind === "text" || turn[cut - 1].kind === "image"))
				cut--;
			const work = turn.slice(0, cut);
			const answer = turn.slice(cut);
			const footer = turnFooter;
			turn = [];
			turnFooter = undefined;
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
					footer,
				});
		};

		for (const m of messages) {
			if (m.role === "user") asked = m.timestamp;
			const before = out.length;
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
					turnFooter = footerFor(m);
					continue;
				}
				flushTurn();
				out.push({
					kind: "message",
					role: m.role,
					blocks,
					labelled: lastRole() !== m.role,
					at: m.timestamp,
				});
				continue;
			}

			if (toolMode !== "grouped") {
				out.push({
					kind: "message",
					role: m.role,
					blocks,
					labelled: lastRole() !== m.role,
					footer: footerFor(m),
					at: m.timestamp,
				});
				continue;
			}

			/*
			 * Tool blocks AND reasoning are peeled off into the run — see ToolGroup
			 * for why reasoning belongs there. It joins even when no run is open
			 * yet, because a turn that opens with a long thought is exactly the
			 * wall of text this mode exists to fold: a thought is never prose the
			 * reader asked for. Everything else stays a message row, and order is
			 * preserved on both sides: a paragraph after three calls ends the run
			 * and starts the next one.
			 */
			let run: PiBlock[] = [];
			const flushRun = () => {
				if (run.length === 0) return;
				out.push({
					kind: "message",
					role: m.role,
					blocks: run,
					labelled: lastRole() !== m.role,
					at: m.timestamp,
				});
				run = [];
			};
			for (const b of blocks) {
				if (b.kind === "tool" || b.kind === "thinking") {
					flushRun();
					pending.push(b);
				} else {
					flushGroup();
					run.push(b);
				}
			}
			flushRun();
			// Under the prose this message ended on, if it produced any.
			const last = out.at(-1);
			if (out.length > before && last?.kind === "message") last.footer = footerFor(m);
		}
		flushGroup();
		flushTurn(busy);
		return out;
	}, [messages, showThinking, toolMode, busy]);

	if (!snapshot) {
		return (
			<main className="flex flex-1 items-center justify-center text-ui text-neutral-500">
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
					<span className="opening-label">{t("Opening session…")}</span>
				) : (
					t("Select a session, or press + New.")
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
	 * Ingest files from a paste, a drop or the file picker.
	 *
	 * Supported images are staged as attachments. Anything else is uploaded to
	 * the pwi machine and its path goes into the message, because the browser
	 * may be on another machine than pi and a local path would mean nothing.
	 */
	const addFiles = async (files: File[]) => {
		if (files.length === 0) return;
		const isImage = (f: File) => SUPPORTED_IMAGE_MIME.includes(f.type);
		if (!canAttach && files.some(isImage)) {
			setAttachError(t("This model does not accept images. Switch models to attach one."));
			return;
		}

		const accepted = files.filter(isImage);
		const others = files.filter((f) => !isImage(f));

		try {
			const paths = await Promise.all(others.map(uploadFile));
			if (paths.length > 0) {
				const current = composer.current?.value ?? text;
				const sep = current && !current.endsWith("\n") ? "\n" : "";
				changeText(current + sep + paths.join("\n"));
			}
			const read = await Promise.all(accepted.map(readImage));
			const kept = read.length === 0 || changeImages([...staged.current, ...read]);
			/*
			 * Both are worth saying, and neither is fatal: the rejected types were
			 * dropped, and images that did not fit in storage are still attached
			 * and still send — they just will not come back after a reload, which
			 * is better said than silently promised.
			 */
			setAttachError(kept ? null : t("Attached, but too large to keep if the page reloads."));
		} catch (err) {
			setAttachError(err instanceof Error ? err.message : String(err));
		}
	};

	const submit = () => {
		const t = text.trim();
		// An image on its own is a valid prompt; only block when nothing is staged.
		if (!t && images.length === 0) return;
		onSend(t, images.length > 0 ? images : undefined, askOnly);
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
	 * Both folding modes collapse a streaming run into the one growing line —
	 * reasoning included. Leaving live reasoning outside the fold made the
	 * running turn the one place a wall of thinking still landed in the
	 * transcript, and then it vanished into a group the moment the turn
	 * settled: the pane jumped, and a mode that promises one line showed
	 * twenty. The fold's own line says it is thinking, and the status line
	 * below still names the running tool.
	 */
	const folds = toolMode === "grouped" || toolMode === "answer";
	const hasPartial =
		partial.text ||
		(showThinking && partial.thinking) ||
		(showTools && liveTools.length > 0);
	/**
	 * The streaming fold's blocks, in the order they happened: the thought that
	 * opened the turn, then the calls. One `thinking` block, not one per delta
	 * — `partial.thinking` is already the accumulated text.
	 */
	const partialFold: PiBlock[] =
		showTools && folds
			? [
					...(showThinking && partial.thinking
						? [{ kind: "thinking", text: partial.thinking } as PiBlock]
						: []),
					// "Answer only" folds live prose too; it leaves the fold once the turn ends.
					...(toolMode === "answer" && partial.text
						? [{ kind: "text", text: partial.text } as PiBlock]
						: []),
					...liveTools.map((t) => ({ kind: "tool", ...t }) as PiBlock),
				]
			: [];

	// The streaming block is one more assistant row, so it follows the same
	// rule: label it only when the last settled row was someone else. A
	// collapsed run of calls is the assistant's too.
	const lastRow = rows.at(-1);
	const partialLabelled =
		!lastRow || (lastRow.kind === "message" && lastRow.role !== "assistant");
	/*
	 * A turn is many messages, and the settled ones end in a fold that the
	 * streaming one continues. Rendered apart they read as two groups; so the
	 * live fold joins the settled one when nothing came between them.
	 */
	const joinFold =
		busy && folds && lastRow?.kind === "tools" && (partialFold.length > 0 || !hasPartial);

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
					{snapshot.messages.length === 0 && !hasPartial && !busy && !command && (
						<div className="flex h-full flex-col items-center justify-center gap-2 text-center select-none">
							<div className="text-display text-amber-400">π</div>
							<div className="text-title text-neutral-200">{t("New session")}</div>
							<div className="text-ui text-neutral-500">
								{t("in")} <span className="font-mono text-neutral-400">{snapshot.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? snapshot.cwd}</span>
								{" · "}{t("type")} <kbd className="font-mono text-neutral-400">/</kbd> {t("for commands")}
							</div>
						</div>
					)}
					{rows.map((r, i) =>
						r.kind === "tools" ? (
							<TranscriptRow key={i} role="assistant" labelled={r.labelled}>
								{joinFold && i === rows.length - 1 ? (
									<ToolGroup blocks={[...r.blocks, ...partialFold]} streaming />
								) : (
									<ToolGroup blocks={r.blocks} />
								)}
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
								userMode={userMode}
								foldThinking={thinkingMode === "folded"}
								footer={r.footer}
								onFork={onFork}
								at={r.at}
								onEdit={busy ? undefined : onEdit}
							/>
						),
					)}

					{hasPartial && (
						<TranscriptRow role="assistant" labelled={partialLabelled}>
							{/*
							 * Grouped while it streams, not just once it settles: the group
							 * line grows in place instead of the pane growing a line per
							 * call, and the status line below still names the running tool.
							 */}
							{partialFold.length > 0 && !joinFold && (
								<ToolGroup blocks={partialFold} streaming />
							)}
							{/* Unfolded modes show the live thought as itself. */}
							{!folds && thinkingMode === "folded" && partial.thinking && (
								<Thought
									text={partial.thinking}
									streaming={!partial.text && liveTools.length === 0}
								/>
							)}
							{!folds && thinkingMode === "shown" && partial.thinking && (
								<Reasoning text={partial.thinking} />
							)}
							{showTools &&
								!folds &&
								liveTools.map((t) => (
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
							{partial.text && toolMode !== "answer" && (
								<MarkdownText text={partial.text} streaming />
							)}
						</TranscriptRow>
					)}

					{busy && <TurnStatus since={turnStart(snapshot.messages)} />}

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
							<div className="chat-measure rounded-sm border border-red-900 bg-red-950/40 px-3 py-2 text-body text-red-300">
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
							<div className="chat-measure flex items-center gap-3 rounded-sm border border-amber-900 bg-amber-950/30 px-3 py-2 text-body text-amber-300">
								<span className="min-w-0 flex-1">
									{t(
										"Packages changed since this session started. Its commands and skills are the old set until it restarts.",
									)}
								</span>
								<Button
									variant="warning"
									size="sm"
									onClick={onRestart}
									disabled={busy}
									title={
										busy
											? t("Finish the turn first — a restart mid-turn loses it")
											: t("Replace this session's pi process; the conversation is kept")
									}
								>
									{t("Restart session")}
								</Button>
							</div>
						</div>
					)}
				</div>

				{/*
				 * Git sits in the READING column, not the wide track, and no rule
				 * separates it from the transcript: the composer is the bottom of
				 * the chat, not a panel docked under it. A border here drew exactly
				 * that second panel. The context meter lives inside the composer.
				 */}
				<div className="chat-gutter py-2">
					<div className="chat-measure flex items-center justify-end gap-2">
						{/*
						 * Git on the right of the status line and ABOVE the composer,
						 * which is where it belongs in the flow: you finish reading the
						 * turn, then you commit it. `onDone` refetches nothing here —
						 * the button owns its own state — but a commit does change the
						 * transcript's context, so the caller gets a hook.
						 */}
						<div className="flex shrink-0 items-center gap-2">
							{/* Jump to the newest message. Only while scrolled away from it:
						    a button that does nothing is worse than no button. */}
							{!atBottom && (
								<IconButton
									onClick={toBottom}
									label={t("Jump to the latest message")}
									variant="outline"
									round
								>
									<ArrowDown size={14} />
								</IconButton>
							)}
							{snapshot.cwd && <GitActions cwd={snapshot.cwd} />}
						</div>
					</div>
				</div>
				<div className="chat-gutter pt-1 pb-6">
					{/* Same column as the prose above it, so the box's edges line up
					    with the text you are replying to. */}
					<div className="chat-measure relative">
						{contextOpen && (
							<ContextPanel
								sessionId={snapshot.id}
								tokens={snapshot.contextTokens}
								window={snapshot.contextWindow}
								busy={busy}
								onCompact={onCompact}
								onClose={closeContext}
							/>
						)}
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
						<div className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 focus-within:border-neutral-700">
							<Attachments
								images={images}
								onRemove={(i) => void changeImages(images.filter((_, n) => n !== i))}
							/>

							{attachError && (
								<div className="mb-2 text-meta text-red-400">{attachError}</div>
							)}

							<textarea
								data-custom="composer"
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
								 * preventDefault ONLY when a file was actually consumed, so a
								 * normal text paste is left completely untouched.
								 */
								onPaste={(e) => {
									const files = Array.from(e.clipboardData.files);
									if (files.length === 0) return;
									e.preventDefault();
									void addFiles(files);
								}}
								onDragOver={(e) => e.preventDefault()}
								onDrop={(e) => {
									const files = Array.from(e.dataTransfer.files);
									if (files.length === 0) return;
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
								// `rows` is the fallback; where `field-sizing: content` is
								// supported the box starts at one line and grows to max-h-60.
								rows={2}
								placeholder={t("Message pi…")}
								title={
									canAttach
										? t("Enter to send, Shift+Enter for newline, Ctrl+V to paste a screenshot")
										: t("Enter to send, Shift+Enter for newline")
								}
								// Transparent and borderless: the BOX is the control now, and a
								// second inset panel inside it was two edges for one field.
								className="chat-prose field-sizing-content max-h-60 w-full resize-none bg-transparent outline-none placeholder:text-neutral-600"
							/>

							{/* Attach and the model on the left, send on the right. */}
							<div className="mt-1 flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-center gap-1.5">
									<IconButton
										onClick={() => fileInput.current?.click()}
										label={t("Attach a file")}
										round
									>
										<Plus size={14} />
									</IconButton>
									<input
										ref={fileInput}
										type="file"
										multiple
										className="hidden"
										onChange={(e) => {
											const files = Array.from(e.target.files ?? []);
											// Reset so picking the SAME file twice still fires onChange.
											e.target.value = "";
											void addFiles(files);
										}}
									/>
									<ModelSelector
										model={snapshot.model}
										disabled={busy}
										error={modelError}
										onChange={onModelChange}
										thinkingLevel={snapshot.thinkingLevel}
										thinkingLevels={snapshot.thinkingLevels}
										onThinkingChange={onThinkingChange}
									/>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<ContextMeter
										tokens={snapshot.contextTokens}
										window={snapshot.contextWindow}
										compacting={compacting}
										open={contextOpen}
										onToggle={() => setContextOpen((o) => !o)}
									/>
									{busy && (
										<IconButton
											onClick={onAbort}
											label={t("Stop")}
											title={t("Stop this turn")}
											variant="outline"
											round
										>
											<Square size={11} weight="fill" />
										</IconButton>
									)}
									<IconButton
										onClick={() => setAskOnly((a) => !a)}
										label={askOnly ? t("Ask only: on (no code changes)") : t("Ask only: off")}
										aria-pressed={askOnly}
										variant={askOnly ? "on" : "ghost"}
										round
									>
										<QuestionMark size={14} weight={askOnly ? "bold" : "regular"} />
									</IconButton>
									<IconButton
										onClick={submit}
										disabled={!text.trim() && images.length === 0}
										label={t("Send")}
										title={t("Send (Enter)")}
										variant="solid"
										round
										// `neutral-200` and not `white`: under a light theme the button
										// is dark text on a light page, and hovering to white would
										// erase it. One step along the ramp moves in a useful direction
										// whichever way the theme runs.
									>
										<ArrowUp size={14} weight="bold" />
									</IconButton>
								</div>
							</div>
						</div>
					</div>
				</div>

				{/* Last, so it paints over everything: an expanded attachment. */}
				{zoomed && <Lightbox src={zoomed} above={composer} onClose={() => setZoomed(null)} />}
			</main>
		</ZoomContext.Provider>
	);
}
