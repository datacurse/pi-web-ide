/**
 * The wire contract between server and browser.
 *
 * Deliberately in its own module with ZERO imports: if these types lived in
 * omp.ts, a stray value-import from the client would drag the RPC boundary and
 * node:child_process into the browser bundle. Here that is impossible.
 */

/**
 * What this server is. `/api/health` reports it, and both the port takeover
 * and the Machines panel refuse to act on a health body that does not carry
 * it — an omp-era piw on a neighbouring port answers `/api/health` too, and
 * mistaking one for the other means killing it or listing its sessions here.
 */
export const PRODUCT = "pi-web-ide";

/**
 * A base64 image. `data` is RAW base64 with no `data:` URL prefix, because
 * that is exactly what the SDK's ImageContent wants — stripping the prefix at
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
	 * `compaction` is omp's `compactionSummary` entry: the history it folded
	 * away, as one summary. Its own role because it is not something anyone
	 * SAID — rendering it as an ordinary message makes a session look like it
	 * opened with a wall of third-person notes about itself.
	 */
	role: "user" | "assistant" | "toolResult" | "compaction" | "other";
	blocks: PiBlock[];
	timestamp: number;
}

/**
 * A line omp printed OUTSIDE the conversation: the output of a local slash
 * command (`/compact`, `/cost`, `/tree`), or a warning from maintenance.
 *
 * These have no message to belong to — a local command never starts a turn —
 * so without a channel of their own the whole answer to a command is dropped
 * and the command looks like it did nothing.
 */
export interface PiNotice {
	level: "info" | "warning" | "error";
	text: string;
}

/**
 * One slash command the session offers, as `get_available_commands` reports
 * it. Narrowed to what a picker shows: omp's own entries carry per-subcommand
 * `usage` strings and source metadata that would triple the size of every
 * snapshot for text nobody reads in a two-line row.
 *
 * `subcommands` is one level deep because omp's are — `/compact soft`,
 * `/mcp add` — and a tree the data never contains is a tree not worth having.
 */
export interface PiCommand {
	name: string;
	description?: string;
	/** Argument shape, e.g. `[on|off|status]`. */
	hint?: string;
	aliases?: string[];
	subcommands?: Array<{ name: string; description?: string }>;
}

/**
 * A question omp is BLOCKED on: the `ask` tool, an extension's `confirm`, a
 * tool approval. All of them arrive as one `extension_ui_request`, and the
 * extension that sent it waits for the answer — so an unanswered one is
 * indistinguishable, from the browser, from a hung agent.
 *
 * `id` is omp's own request id and has to come back with the answer: it is
 * what tells omp which waiting dialog this is, and answering a stale id would
 * answer a question the user never saw.
 */
export interface PiAsk {
	id: string;
	/**
	 * `select` renders the options, `confirm` two buttons, `text` a field.
	 * omp's `input` and `editor` collapse into `text` — the difference is a
	 * one-line prompt versus a full editor, which `multiline` carries.
	 */
	kind: "select" | "confirm" | "text";
	title?: string;
	message?: string;
	/** `select` only. Descriptions are omp's positional `optionDetails`. */
	options?: Array<{ label: string; description?: string }>;
	/** `text` only: omp's prefill, and whether it expects more than a line. */
	value?: string;
	multiline?: boolean;
}

/**
 * An answer to a `PiAsk`, exactly as omp's `extension_ui_response` accepts
 * it: a picked or typed `value`, a `confirmed` boolean, or `cancelled` for a
 * question the user declined. Cancelling is a real answer and not a way to
 * dismiss the panel — omp treats it as the dialog being dismissed, which for
 * the `ask` tool fails the tool call.
 */
export type AskAnswer = { value: string } | { confirmed: boolean } | { cancelled: true };

/**
 * One live child session, as omp's `get_subagents` reports it.
 *
 * Only the RUNNING ones: omp drops a subagent from this list the moment it
 * reaches a terminal status, which is exactly what a roster wants — a child
 * that has finished has delivered its result into the transcript, and the
 * transcript is where it belongs from then on.
 */
export interface PiSubagent {
	id: string;
	/** Which specialist: `scout`, `task`, `reviewer`, … */
	agent: string;
	/** What it was told to do, or what it is doing now if omp knows. */
	description: string;
	status: string;
}

/**
 * The normalized event union. pi emits ~25 event shapes; these are the ones
 * the UI can show.
 * Anything not here is dropped at the adapter on purpose.
 */
export type PiEvent =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| { type: "tool_start"; id: string; name: string; args: unknown }
	| { type: "tool_end"; id: string; name: string; isError: boolean; result: string }
	| { type: "message_done"; message: PiMessage }
	| { type: "notice"; notice: PiNotice }
	| { type: "ask"; ask: PiAsk | null }
	| { type: "subagents"; subagents: PiSubagent[] }
	| { type: "idle" }
	| { type: "error"; message: string };

export interface PiSessionInfo {
	id: string;
	path: string;
	name?: string;
	created: string;
	/**
	 * The last real conversation activity: the timestamp of the last `message`
	 * entry in the session file, NOT the file's mtime. omp appends bookkeeping
	 * rows (and rewrites the title line) when a session is merely resumed, so
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
	 * The question omp is blocked on, or null. In the snapshot and not only an
	 * event because the agent stays blocked across a reload: a question that
	 * lived only in an event would leave the session waiting forever on a
	 * dialog no page can show any more.
	 */
	ask: PiAsk | null;
	/**
	 * Slash commands this session accepts, for the composer's picker. Per
	 * session and not global: the set depends on the project's extensions,
	 * plugins and `.omp/commands` files, so a catalog shared across sessions
	 * would offer commands one of them does not have.
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
	 * Reasoning effort as omp reports it, and the levels this model accepts
	 * ("off" first). Both come from the session rather than a catalog: the set
	 * is per-model (`claude-opus-5` has no "minimal", `claude-haiku-4-5` has
	 * no "max"), and omp ACCEPTS an unknown level and then reports no level at
	 * all — so the list is what makes a picker safe to offer.
	 */
	thinkingLevel: string | undefined;
	thinkingLevels: string[];
	/**
	 * Context occupancy against the model's window, as omp itself accounts for
	 * it (`get_state.contextUsage`): cache reads, system prompt and tools
	 * included, and it DROPS after a compaction. Read from the session rather
	 * than from the transcript's newest `usage.totalTokens`, because that
	 * number still describes the pre-compaction prefix and would leave the
	 * meter reading full until the next turn. `contextWindow` is 0 for a model
	 * that does not declare one.
	 */
	contextTokens: number;
	contextWindow: number;
	/**
	 * The children this session has running right now. In the snapshot as well
	 * as in the event stream because a reload mid-fan-out would otherwise show
	 * a session that is busy for no visible reason — which is the state three
	 * sessions sat in while their parent waited on a subagent nobody could see.
	 */
	subagents: PiSubagent[];
}

/**
 * One other machine running its own piw.
 *
 * Not a session, not a project: nothing about a session crosses a host
 * boundary — the agent stays where the code and the credentials are. The
 * page merges the machines client-side by talking to each piw at its own
 * origin, which is one of two things:
 *
 * - a loopback `port` on the machine serving this page, forwarded by ssh to
 *   the remote piw (`PiwTunnelHost`), or
 * - a `url` both the browser and this server can open directly — a tailnet
 *   name behind `tailscale serve`, which keeps the remote bound to loopback
 *   while giving it a real HTTPS origin (`PiwDirectHost`).
 *
 * The direct form is the one to move to: it needs no tunnel, and HTTPS from
 * `tailscale serve` is HTTP/2, so a page holding one event stream plus a few
 * terminal sockets per host is not counting against the browser's six
 * HTTP/1.1 connections per origin the way it does through an `ssh -L`.
 */
export interface PiwTunnelHost {
	name: string;
	/** ssh destination: an alias from ~/.ssh/config, or user@host. */
	ssh: string;
	/** Local loopback port forwarded to the remote piw. */
	port: number;
	/** The port the remote piw listens on. */
	remotePort: number;
	/** False when the forward is managed outside piw (a systemd unit). */
	autostart: boolean;
}

export interface PiwDirectHost {
	name: string;
	/** Origin of the remote piw, no trailing slash: `https://opi.tail.ts.net`. */
	url: string;
}

export type PiwHost = PiwTunnelHost | PiwDirectHost;

/** A host plus what the server currently observes about it. */
export type PiwHostStatus = PiwHost & {
	/** Our ssh child: running, waiting to retry, not ours at all, or no tunnel involved. */
	tunnel: "running" | "backoff" | "unsupervised" | "direct";
	/** Where the browser reaches this host's piw, for both kinds. */
	url: string;
	/**
	 * A piw answered `/api/health` at `url`. This is the only status worth a
	 * green dot: a live ssh child proves nothing about the machine at the
	 * other end.
	 */
	reachable: boolean;
	remoteCwd?: string;
	/** What the remote reports, so the page can flag a host that lags the fleet. */
	piwVersion?: string;
	ompVersion?: string;
	/**
	 * Whether the remote has ANY hub origins configured. Absent from an older
	 * piw. Separates "never told about hubs" from "allows a different page"
	 * when a request from here fails cross-origin.
	 */
	hubOrigins?: boolean;
	/** Why the last ssh exited, when it exited badly. */
	error?: string;
};

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
