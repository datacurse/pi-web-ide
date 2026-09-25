/**
 * The wire contract between server and browser.
 *
 * Deliberately in its own module with ZERO VALUE imports: if these types lived
 * in agent.ts, a stray value-import from the client would drag the RPC
 * boundary and node:child_process into the browser bundle. Here that is
 * impossible.
 *
 * The one import is `type`-only and points at hunks.ts, which is held to the
 * same rule — so it erases at compile time and drags nothing with it.
 */

import type { Hunk } from "./hunks.js";

/**
 * What this server is. `/api/health` reports it, and the port takeover
 * refuses to act on a health body that does not carry it — a server from the
 * previous install on a neighbouring port answers `/api/health` too, and
 * mistaking one for the other means killing it.
 */
export const PRODUCT = "pi-web-ide";

/**
 * Appended to a prompt sent with the composer's "Ask only" toggle on. The
 * server strips it again in toPiMessage, so the transcript never shows it.
 */
export const ASK_ONLY =
	"\n\n<system-reminder>\nThis is a question only. Do not write or edit code or files, and do not run commands that change anything. Reading files to answer is fine.\n</system-reminder>";

/**
 * A base64 image. `data` is RAW base64 with no `data:` URL prefix, because
 * that is exactly what pi's RPC `images` field takes — stripping the prefix at
 * the browser edge means there is precisely one representation on the wire and
 * nobody downstream has to guess which form they were handed.
 */
export interface PiImage {
	data: string;
	mimeType: string;
}

export type PiBlock =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "image"; data: string; mimeType: string }
	| { kind: "tool"; id: string; name: string; args: unknown; result?: string; isError?: boolean };

export interface PiMessage {
	/**
	 * `compaction` is pi's `compactionSummary` message role: the history it
	 * folded away, as one summary. Its own role because it is not something
	 * anyone SAID — rendering it as an ordinary message makes a session look
	 * like it opened with a wall of third-person notes about itself.
	 */
	role: "user" | "assistant" | "toolResult" | "compaction" | "other";
	blocks: PiBlock[];
	timestamp: number;
}

/**
 * A line that belongs to the session but to no message: an extension's
 * fire-and-forget `notify`, or the compaction and auto-retry notices this
 * server synthesises from pi's own frames.
 *
 * These have no message to belong to — an extension slash command never
 * starts a turn — so without a channel of their own the whole answer to a
 * command is dropped and the command looks like it did nothing.
 */
export interface PiNotice {
	level: "info" | "warning" | "error";
	text: string;
}

/**
 * One slash command the session offers, as `get_commands` reports it.
 * Narrowed to what a picker shows: pi also reports a `sourceInfo` record of
 * paths and scopes that has no place in a two-line row.
 */
export interface PiCommand {
	name: string;
	description?: string;
	/** `extension`, `prompt` or `skill` — shown as the row's right-hand tag. */
	source?: string;
}

/**
 * A question pi is BLOCKED on: an extension's `select`, `confirm`, `input` or
 * `editor`. All of them arrive as one `extension_ui_request`, and the
 * extension that sent it waits for the answer — so an unanswered one is
 * indistinguishable, from the browser, from a hung agent.
 *
 * `id` is pi's own request id and has to come back with the answer: it is
 * what tells pi which waiting dialog this is, and answering a stale id would
 * answer a question the user never saw.
 */
export interface PiAsk {
	id: string;
	/**
	 * `select` renders the options, `confirm` two buttons, `text` a field.
	 * pi's `input` and `editor` collapse into `text` — the difference is a
	 * one-line prompt versus a full editor, which `multiline` carries.
	 */
	kind: "select" | "confirm" | "text";
	title?: string;
	message?: string;
	/** `select` only. pi sends plain option strings. */
	options?: Array<{ label: string }>;
	/** `text` only: pi's prefill, and whether it expects more than a line. */
	value?: string;
	multiline?: boolean;
}

/**
 * An answer to a `PiAsk`, exactly as pi's `extension_ui_response` accepts
 * it: a picked or typed `value`, a `confirmed` boolean, or `cancelled` for a
 * question the user declined. Cancelling is a real answer and not a way to
 * dismiss the panel — pi treats it as the dialog being dismissed, which for
 * the `ask` tool fails the tool call.
 */
export type AskAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

/**
 * The normalized event union. pi emits ~25 event shapes; these are the ones
 * the UI can show.
 * Anything not here is dropped at the adapter on purpose.
 */
export type PiEvent =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	/**
	 * Streaming tool output. `result` is CUMULATIVE — pi's `partialResult`
	 * carries everything produced so far — so a consumer replaces the card's
	 * output with it rather than appending.
	 */
	| { type: "tool_update"; id: string; result: string }
	| { type: "tool_end"; id: string; name: string; isError: boolean; result: string }
	| { type: "message_done"; message: PiMessage }
	| { type: "notice"; notice: PiNotice }
	| { type: "ask"; ask: PiAsk | null }
	| { type: "idle" }
	| { type: "error"; message: string };

export interface PiSessionInfo {
	id: string;
	path: string;
	name?: string;
	created: string;
	/**
	 * The last real conversation activity: the timestamp of the last `message`
	 * entry in the session file, NOT the file's mtime. pi appends bookkeeping
	 * rows (`session_info`, `model_change`) when a session is merely resumed, so
	 * an mtime-ordered list reshuffles itself just from being looked at.
	 */
	lastActive: string;
	messageCount: number;
	firstMessage: string;
	/** True if this session is currently streaming, even with no client attached. */
	isStreaming?: boolean;
}

/** A partially-streamed assistant message, assembled server-side. */
export interface PiPartial {
	text: string;
	thinking: string;
	tools: Array<{ id: string; name: string; args: unknown; result?: string; isError?: boolean }>;
}

export interface Snapshot {
	id: string;
	file: string | undefined;
	/**
	 * The directory the session's agent actually runs in — for a resumed
	 * session that is its own header's cwd, not whichever project the browser
	 * had selected. The git button acts on it, so it comes from the session
	 * rather than from the client's idea of the current project.
	 */
	cwd: string;
	/** "provider/id", or undefined if the session has no model selected yet. */
	model: string | undefined;
	messages: PiMessage[];
	partial: PiPartial | null;
	isStreaming: boolean;
	error: string | null;
	/**
	 * Output of local slash commands, plus maintenance warnings, newest last.
	 * Part of the snapshot and not only an event, so a reload or a dropped
	 * EventSource does not lose the answer to the last command. Cleared when
	 * the next prompt is accepted.
	 */
	notices: PiNotice[];
	/**
	 * The question pi is blocked on, or null. In the snapshot and not only an
	 * event because the agent stays blocked across a reload: a question that
	 * lived only in an event would leave the session waiting forever on a
	 * dialog no page can show any more.
	 */
	ask: PiAsk | null;
	/**
	 * Changes this session's agent made to files, oldest first.
	 *
	 * ALREADY ON DISK. pi's edit tool writes during execution and this server
	 * installs no `tool_call` gate, so a diff tab shows what happened
	 * rather than what is proposed: accepting is a no-op that records a
	 * decision, and rejecting is what writes the old text back.
	 *
	 * In the snapshot rather than only on an event because a decision outlives
	 * the turn that produced it — a reload mid-review would otherwise lose
	 * every pending change with nothing on screen to say they happened.
	 */
	hunks: Hunk[];
	/**
	 * Slash commands this session accepts, for the composer's picker. Per
	 * session and not global: the set depends on the project's extensions,
	 * skills and prompt templates under `.pi/`, so a catalog shared across
	 * sessions would offer commands one of them does not have.
	 */
	commands: PiCommand[];
	/**
	 * Whether the CURRENT model accepts image input. Server-authoritative and
	 * part of the snapshot rather than inferred client-side, so switching to a
	 * text-only model immediately disables pasting instead of letting the user
	 * attach a screenshot that the provider would reject with a 400.
	 */
	supportsImages: boolean;
	/**
	 * Reasoning effort as pi reports it, and the levels this model accepts
	 * (`get_available_thinking_levels`). Both come from the session rather
	 * than a catalog: the set is per-model, and pi ACCEPTS an unknown level
	 * and then reports no level at all — so the list is what makes a picker
	 * safe to offer. Empty when the model offers no real choice.
	 */
	thinkingLevel: string | undefined;
	thinkingLevels: string[];
	/**
	 * Context occupancy against the model's window, as pi itself accounts for
	 * it (`get_session_stats.contextUsage`): cache reads, system prompt and
	 * tools included, and it DROPS after a compaction. Read from the session
	 * rather than from the transcript's newest `usage.totalTokens`, because
	 * that number still describes the pre-compaction prefix and would leave
	 * the meter reading full until the next turn. `contextWindow` is 0 for a
	 * model that does not declare one.
	 */
	contextTokens: number;
	contextWindow: number;
	/**
	 * This session's pi child started before the newest package install, so
	 * it does not have the newly installed extensions, skills or prompt
	 * templates — pi reads those once, at startup. The UI offers a restart;
	 * the server never restarts a session on its own.
	 */
	stale: boolean;
}

/**
 * One entry of pi's `packages` array, plus what is actually on disk.
 *
 * `identity` is pi's own rule for "the same package": the npm name, the git
 * URL without its ref, or the resolved absolute path. It is what makes two
 * spellings of one package the same row.
 */
export interface PiwPackage {
	/** Exactly as written in settings.json. */
	source: string;
	kind: "npm" | "git" | "local";
	identity: string;
	/** The version or ref the source pins, or null for an unpinned source. */
	pinned: string | null;
	/** What is on disk: a package.json version, or a short git HEAD. */
	installed: string | null;
	/** Written in object form with resource filters: it loads only part of itself. */
	filtered: boolean;
	/** `autoload: false` — installed, but not loaded unless a project asks for it. */
	autoload: boolean;
}

/** `GET /api/packages` on one machine. */
export interface PiwPackagesView {
	packages: PiwPackage[];
	/** Bumped on every successful mutation; a session started under an older one is stale. */
	epoch: number;
	/** A mutation is running here. The next request will wait rather than fail. */
	busy: boolean;
	piVersion: string | null;
}

/** What a package mutation did, as the screen reports it. */
export interface PiwMutation {
	ok: boolean;
	/** The tail of pi's combined output: what npm or git said, verbatim. */
	log: string;
	/** One line, when it failed. */
	reason?: string;
}

/** One npm gallery hit: a package carrying the `pi-package` keyword. */
export interface PiwSearchHit {
	name: string;
	version: string;
	description?: string;
	publisher?: string;
	published?: string;
	repository?: string;
}

/** One package in detail, as the install dialog shows it. */
export interface PiwPackageInfo {
	name: string;
	/** The newest published version — what an install would pin to. */
	latest: string;
	description?: string;
	publisher?: string;
	published?: string;
	repository?: string;
	contains: { extensions: number; skills: number; prompts: number; themes: number };
	image?: string;
	video?: string;
	weeklyDownloads?: number;
}

/**
 * One browsable subdirectory, as the project picker lists them.
 *
 * Directories only: a project IS a cwd, so files are noise here. The two
 * flags exist because the picker must not need a second request to decide how
 * to present a row.
 */
export interface PiwDirEntry {
	name: string;
	/** Absolute, so the client never joins paths itself. */
	path: string;
	/** Contains a `.git`. A project is usually a checkout, so it is worth marking. */
	repo: boolean;
	/** A dotted name. Sorted last rather than dropped — ~/.config stays reachable. */
	hidden: boolean;
}

/**
 * One row in the editor's file tree — a file or a directory.
 *
 * Deliberately NOT `PiwDirEntry`: that list feeds the project picker, where
 * only a directory can be the answer and "is it a checkout" is the useful
 * flag. Here a file is the entire point, and the flag that matters is whether
 * clicking a row opens a buffer or expands a level.
 */
export interface PiwFileEntry {
	name: string;
	/** Absolute, so the client never joins paths itself. */
	path: string;
	dir: boolean;
	/** A dotted name. Sorted last rather than dropped — .gitignore stays reachable. */
	hidden: boolean;
}

/** One directory's children, as `GET /api/browse` answers. */
export interface PiwDirListing {
	/** The path actually listed: absolute, with `~` and symlinks in the name resolved. */
	path: string;
	/** null at the filesystem root, where "up" has nowhere to go. */
	parent: string | null;
	/** The server's home directory, for the picker's one fixed shortcut. */
	home: string;
	entries: PiwDirEntry[];
}
