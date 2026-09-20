/**
 * agent.ts — THE RPC BOUNDARY.
 *
 * The only file that spawns or speaks to `pi`. One `pi --mode rpc` child
 * process per open session, driven over newline-delimited JSON on stdio.
 *
 * Talking to a subprocess rather than importing an SDK buys two things an
 * in-process session cannot:
 *
 *   - Isolation. A tool that segfaults its host, or an OOM inside one
 *     conversation, takes down one child rather than the whole server and
 *     every other session with it.
 *   - Restartability. Conversation state lives in pi's own JSONL under
 *     ~/.pi/agent/sessions/<cwd>/, so a child is disposable:
 *     `--session <file>` rehydrates one for the cost of a spawn, preserving
 *     both the session id and the file (verified — docs/pi-facts.md §0.4).
 *     Restarting this server loses at most an in-flight turn, not the work.
 *
 * The cost is that everything is async and nothing can be read out of a live
 * object, so this file keeps a small server-side mirror of session state
 * (messages, model, streaming) fed by the event stream. `messages()` stays
 * synchronous for callers; the mirror is what makes that possible.
 *
 * Everything arriving from the child is external input and is typed `unknown`,
 * narrowed through `isRecord` and explicit field checks. The wire is the one
 * place where a structural assumption turns into a silent rendering bug.
 */

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

import { isRecord, records } from "./guards.js";
import { personalityPath } from "./personality.js";
import { sessionHeaderCwd } from "./sessions.js";
import type {
	AskAnswer,
	PiAsk,
	PiBlock,
	PiCommand,
	PiEvent,
	PiImage,
	PiMessage,
	PiPartial,
	PiSessionInfo,
} from "../shared/types.js";

export type {
	AskAnswer,
	PiAsk,
	PiBlock,
	PiCommand,
	PiEvent,
	PiImage,
	PiMessage,
	PiPartial,
	PiSessionInfo,
};

/**
 * A systemd user unit gets a minimal PATH that usually omits the directory an
 * `npm i -g` puts `pi` in, so "pi" on PATH is not a safe assumption in the
 * deployment this project is built for. PIW_PI_BIN is the escape hatch, and
 * the ENOENT message below names it.
 */
export const PI_BIN = process.env.PIW_PI_BIN ?? "pi";

/**
 * pi emits nothing unprompted at startup — no ready frame, no protocol
 * negotiation (docs/pi-facts.md §0.2). Readiness is therefore the first
 * successful `get_state`, which answered in 3 ms on a warm machine. The
 * generous ceiling is for a cold Pi 5 doing package and skill discovery.
 */
const READY_TIMEOUT_MS = 60_000;

/** Grace between "close stdin" and SIGTERM when disposing a child. */
const DISPOSE_GRACE_MS = 5_000;

/**
 * How long a `/command` prompt may stay silent before it is treated as having
 * run locally.
 *
 * pi gives no "the agent was not invoked" signal: an extension command emits
 * its `notify` (if it has one) and the plain `{success:true}` prompt ack, and
 * nothing else — no `agent_start`, no `agent_settled` (docs/pi-facts.md §0.8).
 * The absence of `agent_start` is the only evidence, so it is timed. Long
 * enough to cover a provider's first-token latency, short enough that a
 * command that prints and exits does not leave a spinner behind.
 */
const LOCAL_COMMAND_MS = 1_500;

/**
 * MIME types pi can sniff and forward. Anything else is rejected at the door
 * rather than discovered as a provider 400 three layers down.
 */
const SUPPORTED_IMAGE_MIME: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};

/** Hard ceiling on a single decoded attachment. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** How much child stderr to keep for error messages. Auth failures land here. */
const STDERR_KEEP = 4_000;

/** One message as pi models it. Field access goes through the shared guards. */
type AgentMessage = Record<string, unknown>;

export function emptyPartial(): PiPartial {
	return { text: "", thinking: "", tools: [] };
}

// ---------------------------------------------------------------------------
// Conversion helpers
//
// Verified against a live `read` + `bash` turn, committed as
// fixtures/pi-turn.jsonl and replayed by agent.test.ts.
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return records(content)
		.map((c) => (c.type === "text" ? String(c.text ?? "") : c.type === "image" ? "[image]" : ""))
		.join("");
}

/**
 * Validate one pasted image.
 *
 * Note what is deliberately NOT here: resizing. Across RPC the image is pi's
 * to normalize for the provider, and the only way to resize here would be a
 * native image dependency — a large cost for a step the agent already owns.
 * So this validates (type, non-empty, ceiling) and passes the bytes through.
 * A rejection here is reportable to the user; a provider 400 is not.
 */
function toImageContent(img: PiImage): { type: "image"; data: string; mimeType: string } {
	if (!SUPPORTED_IMAGE_MIME[img.mimeType]) {
		throw new Error(`unsupported image type: ${img.mimeType}`);
	}

	const bytes = Buffer.from(img.data, "base64");
	if (bytes.length === 0) throw new Error("image is empty or not valid base64");
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw new Error(`image is ${Math.round(bytes.length / 1024 / 1024)}MB, limit is 20MB`);
	}

	return { type: "image", data: img.data, mimeType: img.mimeType };
}

/**
 * Flatten one pi message into our shape. Tool CALLS live on assistant
 * messages and tool RESULTS arrive as separate `toolResult` messages; we keep
 * them separate here and let the caller stitch, which keeps this pure.
 */
export function toPiMessage(m: AgentMessage): PiMessage {
	const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.now();

	if (m.role === "user") {
		// User content is an array once images are involved, so walk it rather
		// than flattening to text — otherwise a resumed session renders "[image]"
		// where the screenshot should be, and the transcript silently loses the
		// thing the question was about.
		const blocks: PiBlock[] = [];
		if (typeof m.content === "string") {
			blocks.push({ kind: "text", text: m.content });
		} else {
			for (const c of records(m.content)) {
				if (c.type === "text") blocks.push({ kind: "text", text: String(c.text ?? "") });
				else if (c.type === "image")
					blocks.push({
						kind: "image",
						data: String(c.data ?? ""),
						mimeType: String(c.mimeType ?? "image/png"),
					});
			}
		}
		return { role: "user", blocks, timestamp };
	}

	if (m.role === "assistant") {
		const blocks: PiBlock[] = [];
		for (const c of records(m.content)) {
			if (c.type === "text") blocks.push({ kind: "text", text: String(c.text ?? "") });
			else if (c.type === "thinking")
				blocks.push({ kind: "thinking", text: String(c.thinking ?? "") });
			else if (c.type === "toolCall")
				blocks.push({
					kind: "tool",
					id: String(c.id ?? ""),
					name: String(c.name ?? ""),
					args: c.arguments,
				});
		}
		return { role: "assistant", blocks, timestamp };
	}

	if (m.role === "toolResult") {
		return {
			role: "toolResult",
			blocks: [
				{
					kind: "tool",
					id: String(m.toolCallId ?? ""),
					name: String(m.toolName ?? ""),
					args: undefined,
					result: textOf(m.content),
					isError: Boolean(m.isError),
				},
			],
			timestamp,
		};
	}

	/*
	 * A compaction summary keeps its text in `summary`, NOT in `content`, so
	 * reading content here renders the compaction boundary as an empty row. It
	 * also gets its own role, so the UI can draw the boundary it is;
	 * branchSummary / bashExecution / custom stay text.
	 */
	const text = typeof m.summary === "string" ? m.summary : textOf(m.content);
	const role = m.role === "compactionSummary" ? "compaction" : "other";
	return { role, blocks: [{ kind: "text", text }], timestamp };
}

/**
 * Narrow pi's command catalog to what the composer's picker shows.
 *
 * Dropped on the way through: `sourceInfo`, a record of path, scope, origin
 * and base directory for every command. It rides in every snapshot and none
 * of it fits a two-line row.
 *
 * A command with no name is skipped rather than rendered: it would be an
 * empty row that inserts nothing.
 */
export function toCommands(list: unknown): PiCommand[] {
	const out: PiCommand[] = [];
	for (const c of records(list)) {
		const name = typeof c.name === "string" ? c.name : "";
		if (!name) continue;
		out.push({
			name,
			...(typeof c.description === "string" ? { description: c.description } : {}),
			...(typeof c.source === "string" ? { source: c.source } : {}),
		});
	}
	return out;
}

/**
 * Answer tool CALLS that never got a RESULT.
 *
 * A turn can die between the two: the assistant message is persisted at
 * message_end, tool results are persisted one by one after it, so a crash — or
 * a bash tool that kills its own host process — leaves a dangling `tool_use`
 * in the JSONL. Every later prompt then replays that shape and the provider
 * rejects the whole request ("tool_use ids were found without tool_result
 * blocks"), so the session file is bricked, not just the one turn. Neither pi
 * nor the provider heals this; we do, at open time.
 */
export function healDanglingToolCalls(messages: AgentMessage[]): AgentMessage[] {
	const answered = new Set<unknown>();
	for (const m of messages) {
		if (m.role === "toolResult") answered.add(m.toolCallId);
	}

	const out: AgentMessage[] = [];
	for (const m of messages) {
		out.push(m);
		if (m.role !== "assistant") continue;
		for (const c of records(m.content)) {
			if (c.type !== "toolCall" || answered.has(c.id)) continue;
			out.push({
				role: "toolResult",
				toolCallId: c.id,
				toolName: c.name,
				content: [
					{
						type: "text",
						text: "Interrupted: the session ended before this tool returned.",
					},
				],
				isError: true,
				timestamp: typeof m.timestamp === "number" ? m.timestamp : Date.now(),
			});
		}
	}
	return out;
}

/**
 * Is this a message a reader is supposed to see?
 *
 * pi 0.86 began PERSISTING the system prompt as a `system` message at the
 * head of every session, with `content: ""` and the real text under
 * `sections`. `get_messages` returns it, so without this filter every
 * transcript opens with a blank row above the first thing anybody said —
 * observed on a 0.86.0 box while the hub was still on 0.85.1.
 *
 * Dropped rather than rendered: the system prompt is configuration, it is
 * the same on every turn, and the personality half of it is already editable
 * in Settings.
 */
export function isConversation(m: AgentMessage): boolean {
	return m.role !== "system";
}

/**
 * Stitch tool results onto their originating calls and drop the now-redundant
 * toolResult messages, so the UI renders one row per tool invocation.
 */
export function stitch(messages: PiMessage[]): PiMessage[] {
	const results = new Map<string, { result: string; isError: boolean }>();
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		for (const b of m.blocks) {
			if (b.kind === "tool")
				results.set(b.id, { result: b.result ?? "", isError: Boolean(b.isError) });
		}
	}

	return messages
		.filter((m) => m.role !== "toolResult")
		.map((m) => ({
			...m,
			blocks: m.blocks.map((b) => {
				if (b.kind !== "tool") return b;
				const r = results.get(b.id);
				return r ? { ...b, result: r.result, isError: r.isError } : b;
			}),
		}));
}

// ---------------------------------------------------------------------------
// Frame transport
// ---------------------------------------------------------------------------

/**
 * Splits the child's stdout into logical JSON frames.
 *
 * Split on raw 0x0A BYTES, not on decoded string chunks. A frame can be a
 * megabyte of UTF-8 and arrive in arbitrary pieces; decoding each piece
 * independently would corrupt any multi-byte character straddling the
 * boundary. 0x0A never appears inside a multi-byte UTF-8 sequence, so
 * splitting first and decoding whole lines is safe.
 *
 * LF is the ONLY record delimiter pi guarantees, and it explicitly warns that
 * Node's `readline` is non-compliant because it also splits on U+2028/U+2029,
 * which are legal inside a JSON string. One trailing CR is stripped, as the
 * protocol asks.
 */
export class FrameReader {
	// Explicit `ArrayBufferLike`: under the ES2024 lib, `Buffer.concat` is
	// typed as the general buffer and `Buffer.alloc` as the narrow one.
	private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	constructor(
		private readonly onFrame: (frame: Record<string, unknown>) => void,
		private readonly onProtocolError: (message: string) => void,
	) {}

	push(data: Buffer): void {
		this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
		let nl: number;
		while ((nl = this.buf.indexOf(0x0a)) !== -1) {
			let line = this.buf.subarray(0, nl);
			this.buf = this.buf.subarray(nl + 1);
			if (line.length > 0 && line[line.length - 1] === 0x0d) {
				line = line.subarray(0, line.length - 1);
			}
			if (line.length > 0) this.line(line.toString("utf8"));
		}
	}

	private line(text: string): void {
		if (!text.trim()) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			// Not recoverable data, but also not fatal: report and keep reading.
			this.onProtocolError(`unparseable frame: ${text.slice(0, 200)}`);
			return;
		}
		if (!isRecord(parsed)) {
			this.onProtocolError(`frame is not an object: ${text.slice(0, 120)}`);
			return;
		}
		this.onFrame(parsed);
	}
}

interface Pending {
	command: string;
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
}

/**
 * One pi child process, with request/response correlation.
 *
 * Responses are matched on `id`, never on arrival order: commands are
 * dispatched concurrently by the server, so a later one can answer first.
 */
class RpcChild {
	private readonly pending = new Map<string, Pending>();
	private readonly frameListeners = new Set<(frame: Record<string, unknown>) => void>();
	private readonly reader: FrameReader;
	private seq = 0;
	private stderrTail = "";
	private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;

	private constructor(
		private readonly kill: (signal: NodeJS.Signals) => void,
		private readonly stdin: Writable,
	) {
		this.reader = new FrameReader(
			(frame) => this.dispatch(frame),
			(message) => console.error("[piw] rpc transport:", message),
		);
	}

	static async start(args: string[], cwd: string): Promise<RpcChild> {
		const proc = spawn(PI_BIN, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// Inherit the environment: pi resolves credentials, settings, and the
			// model catalog from it.
			env: process.env,
		});

		const { stdin, stdout, stderr } = proc;
		if (!stdin || !stdout || !stderr) throw new Error("pi child was spawned without stdio pipes");

		const child = new RpcChild((signal) => proc.kill(signal), stdin);
		stdout.on("data", (d: Buffer) => child.reader.push(d));
		(stderr as Readable).on("data", (d: Buffer) => {
			child.stderrTail = (child.stderrTail + d.toString("utf8")).slice(-STDERR_KEEP);
		});

		/*
		 * Readiness is a round trip, not a frame to wait for. Spawn failure and
		 * early exit have to be raced against it: an ENOENT or a child that dies
		 * during package installation would otherwise leave `get_state` pending
		 * until the timeout, reporting a timeout instead of the real reason.
		 */
		const failed = new Promise<never>((_resolve, reject) => {
			proc.once("error", (err: NodeJS.ErrnoException) => {
				reject(
					err.code === "ENOENT"
						? new Error(
								`cannot run "${PI_BIN}": not found on PATH. Set PIW_PI_BIN to its absolute path (a systemd user unit does not read your shell profile).`,
							)
						: err,
				);
			});
			proc.once("exit", (code, signal) => reject(new Error(child.exitMessage(code, signal))));
		});
		const timeout = new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`pi did not answer within ${READY_TIMEOUT_MS / 1000}s`)),
				READY_TIMEOUT_MS,
			);
			timer.unref();
		});

		proc.once("exit", (code, signal) => child.onExit(code, signal));

		try {
			await Promise.race([child.send("get_state"), failed, timeout]);
		} catch (err) {
			proc.kill("SIGKILL");
			throw err;
		}

		return child;
	}

	onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	private dispatch(frame: Record<string, unknown>): void {
		if (frame.type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			const pending = id === undefined ? undefined : this.pending.get(id);

			if (id !== undefined && pending) {
				this.pending.delete(id);
				if (frame.success === true) pending.resolve(frame.data);
				else pending.reject(new Error(String(frame.error ?? `${pending.command} failed`)));
				return;
			}

			// Parse failures arrive with no id, and so do responses to commands
			// whose caller has already gone. Neither can be routed.
			if (frame.success !== true) {
				console.error(`[piw] pi ${String(frame.command)} failed:`, String(frame.error ?? ""));
			}
			return;
		}

		for (const listener of [...this.frameListeners]) {
			try {
				listener(frame);
			} catch (err) {
				console.error("[piw] frame listener threw:", err);
			}
		}
	}

	send<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
		if (this.exited) {
			return Promise.reject(new Error(this.exitMessage(this.exited.code, this.exited.signal)));
		}

		const id = `r${++this.seq}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, {
				command: type,
				resolve: (data) => resolve(data as T),
				reject,
			});
			this.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, (err) => {
				if (!err) return;
				this.pending.delete(id);
				reject(err);
			});
		});
	}

	/** Fire-and-forget frames: UI responses have no reply of their own. */
	post(frame: Record<string, unknown>): void {
		if (this.exited) return;
		this.stdin.write(`${JSON.stringify(frame)}\n`, () => {});
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.exited = { code, signal };
		const message = this.exitMessage(code, signal);
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(new Error(message));
		}
	}

	private exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
		const how = signal ? `signal ${signal}` : `code ${code}`;
		const tail = this.stderrTail.trim().split("\n").slice(-6).join("\n");
		return tail ? `pi exited (${how}):\n${tail}` : `pi exited (${how})`;
	}

	/**
	 * Closing stdin is the clean shutdown: pi drains accepted commands, saves
	 * the session, and exits. The timers are for the case where it does not —
	 * a wedged child must not outlive its session and hold a JSONL open.
	 */
	close(): void {
		if (this.exited) return;
		try {
			this.stdin.end();
		} catch {
			// Already gone; the kill timers below still apply.
		}
		const term = setTimeout(() => this.kill("SIGTERM"), DISPOSE_GRACE_MS);
		const hard = setTimeout(() => this.kill("SIGKILL"), DISPOSE_GRACE_MS * 2);
		term.unref();
		hard.unref();
	}
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A live session, wrapped so callers never touch a frame or a child process. */
export interface PiSession {
	readonly id: string;
	readonly file: string | undefined;
	/**
	 * The directory the child was actually launched in. For a resume that is
	 * the session header's cwd, NOT the caller's — see openSession — which is
	 * what makes it the authority on which project a session belongs to.
	 */
	readonly cwd: string;
	readonly isStreaming: boolean;
	/** "provider/id", or undefined if the session has no model selected yet. */
	readonly model: string | undefined;
	/** Whether the currently selected model accepts image input. */
	readonly supportsImages: boolean;
	/** Current reasoning effort, and the levels this model accepts. */
	readonly thinkingLevel: string | undefined;
	readonly thinkingLevels: string[];
	/** Tokens in context as of the last assistant turn, and the model's ceiling. */
	readonly contextTokens: number;
	readonly contextWindow: number;
	/** Slash commands this session accepts. */
	readonly commands: PiCommand[];
	/** The question pi is blocked on, or null if it is not waiting on one. */
	readonly ask: PiAsk | null;
	messages(): PiMessage[];
	prompt(text: string, images?: PiImage[]): Promise<void>;
	abort(): Promise<void>;
	/**
	 * Fold the conversation into a summary now.
	 *
	 * The only way to compact from a browser: pi's own `/compact` is a TUI
	 * command and `get_commands` deliberately omits those, so without this the
	 * only compaction a session here would ever see is the automatic one at
	 * the threshold — by which point the turn that tripped it has already been
	 * paid for at full width.
	 */
	compact(): Promise<void>;
	/** Re-read the slash command catalog. The composer calls this when its menu opens. */
	refreshCommands(): Promise<PiCommand[]>;
	/**
	 * Answer the pending question. False if `id` is not the one pi is
	 * actually waiting on — the caller's answer is then for a dialog that has
	 * already gone, and sending it would misattribute it to the next one.
	 */
	answerAsk(id: string, answer: AskAnswer): boolean;
	/** Switch models mid-session. Throws if the spec is malformed or unresolvable. */
	setModel(spec: string): Promise<void>;
	/**
	 * Set the reasoning effort. Throws on a level this model does not accept:
	 * pi answers `success` to any string and then reports NO level at all,
	 * so the check has to happen on this side of the boundary.
	 */
	setThinkingLevel(level: string): Promise<void>;
	/**
	 * Rename the session. pi owns the name: `set_session_name` appends a
	 * `session_info` entry to the JSONL, which is the file this server only
	 * ever reads. Writing that entry by hand would mean appending to a file pi
	 * has open.
	 */
	setName(name: string): Promise<void>;
	subscribe(listener: (e: PiEvent) => void): () => void;
	dispose(): void;
}

export interface OpenOptions {
	cwd: string;
	/** Existing session file to resume. Omit to create a new persisted session. */
	file?: string;
	/** "provider/id", e.g. "anthropic/claude-sonnet-4-5". Omit for pi's default. */
	model?: string;
}

interface SessionState {
	sessionId: string;
	sessionFile: string | undefined;
	model: string | undefined;
	supportsImages: boolean;
	isStreaming: boolean;
	thinkingLevel: string | undefined;
	thinkingLevels: string[];
	contextWindow: number;
	contextTokens: number;
}

/**
 * The arguments a session child is spawned with.
 *
 * Exported for the test: which flags reach pi is the single most consequential
 * line in this file, and the ones that are NOT here are the point —
 * `--mode rpc`, no `--cwd` (pi has none; the directory is the spawn's), no
 * approval mode (pi has none), and `--session <file>` rather than `-r`, which
 * in pi opens an interactive picker and takes no path.
 */
export function spawnArgs(opts: { file?: string; model?: string; personality?: string }): string[] {
	const args = ["--mode", "rpc"];
	// Project-local extensions, skills and prompt templates are silently
	// skipped in RPC mode without this — no prompt, no warning, they are just
	// absent (docs/pi-facts.md §0.11). There is no TTY here to answer a trust
	// question on, and a browser client that opens a project has already
	// decided to run its code.
	args.push("--approve");
	if (opts.file) args.push("--session", opts.file);
	if (opts.model) args.push("--model", opts.model);
	// `--append-system-prompt` accepts a path and reads the file. Applied at
	// spawn, so an edit reaches children started after the save — which is what
	// the settings dialog says.
	if (opts.personality) args.push("--append-system-prompt", opts.personality);
	return args;
}

/**
 * One question to a throwaway child.
 *
 * For the things that are pi's to answer but belong to no conversation — the
 * model catalog, most of all. agent.ts owns it because agent.ts is the only
 * file allowed to spawn an RPC child or read its frames.
 */
export async function askOnce<T = unknown>(command: string, cwd: string): Promise<T> {
	const child = await RpcChild.start(["--mode", "rpc", "--no-session"], cwd);
	try {
		return await child.send<T>(command);
	} finally {
		child.close();
	}
}

/**
 * Open (or resume) a session.
 *
 * Sessions are ALWAYS persisted (never --no-session): persistence is the real
 * crash safety net that makes the error handling here an optimization rather
 * than load-bearing.
 */
export async function openSession(opts: OpenOptions): Promise<PiSession> {
	/*
	 * A resumed session's cwd comes from its own header, not from the caller.
	 * The open route only knows a cwd when CREATING, so resuming a session that
	 * belongs to another project would otherwise launch the agent pointed at
	 * whichever project the client happened to have selected — and its tools
	 * would then read and write the wrong tree. The header is authoritative.
	 */
	let cwd = opts.cwd;
	if (opts.file) {
		// pi resolves a missing `--session` path as a partial session id and
		// would start an unrelated session, or none. Fail with the path instead.
		if (!existsSync(opts.file)) throw new Error(`session file not found: ${opts.file}`);
		cwd = (await sessionHeaderCwd(opts.file)) ?? opts.cwd;
	}

	// An empty personality file means the user cleared the box, which is how
	// the override is turned off; passing it anyway would append a blank line
	// to every system prompt.
	let personality: string | undefined;
	try {
		personality = statSync(personalityPath()).size > 0 ? personalityPath() : undefined;
	} catch {
		// No file: nothing to append.
	}

	const child = await RpcChild.start(
		spawnArgs({ file: opts.file, model: opts.model, personality }),
		cwd,
	);

	const state = await fetchState(child);
	let messages = healDanglingToolCalls(await fetchMessages(child));
	/**
	 * Bumped on every appended message. A resync that started before an append
	 * must not overwrite the newer list — pi accepts a follow-up prompt the
	 * moment a turn ends, so the race is routine, not theoretical.
	 */
	let generation = 0;
	let model = state.model;
	let supportsImages = state.supportsImages;
	let streaming = state.isStreaming;
	let thinkingLevel = state.thinkingLevel;
	let thinkingLevels = state.thinkingLevels;
	let contextWindow = state.contextWindow;
	let contextTokens = state.contextTokens;
	let commands = toCommands(await fetchCommands(child));

	const listeners = new Set<(e: PiEvent) => void>();
	const emit = (e: PiEvent) => {
		for (const l of [...listeners]) {
			try {
				l(e);
			} catch {
				// A broken listener must never take down the agent run.
			}
		}
	};

	/**
	 * Re-read everything the SESSION decides: which modalities the model takes,
	 * which reasoning levels it offers, how big its window is, and how much of
	 * that window is occupied. Three cheap round trips that cannot drift,
	 * rather than trusting an event frame's own shape.
	 */
	const refreshState = (): Promise<void> =>
		fetchState(child)
			.then((s) => {
				model = s.model;
				supportsImages = s.supportsImages;
				thinkingLevel = s.thinkingLevel;
				thinkingLevels = s.thinkingLevels;
				contextWindow = s.contextWindow;
				contextTokens = s.contextTokens;
			})
			.catch(() => {});

	/**
	 * Re-read the whole history from pi.
	 *
	 * The accumulated `message_end` list is normally complete and correct, so
	 * this is a correction pass rather than the primary path: compaction
	 * REPLACES history with a summary, and nothing in the event stream conveys
	 * a deletion. Without this, a compacted session keeps rendering the
	 * pre-compaction transcript until the entry is evicted and reopened.
	 */
	const resyncMessages = (): Promise<void> => {
		const at = generation;
		return fetchMessages(child)
			.then((fresh) => {
				if (generation !== at || fresh.length === 0) return;
				messages = healDanglingToolCalls(fresh);
			})
			.catch(() => {
				// The accumulated list stands; the next settle tries again.
			});
	};

	/**
	 * A `/command` prompt that produced no agent run.
	 *
	 * Armed by `prompt`, disarmed by `agent_start`. When it fires, the command
	 * was an extension command: it has already done whatever it does, nothing
	 * further is coming, and the session state it may have changed (a model, a
	 * name, the transcript) has to be re-read because no event reports it.
	 */
	let localTimer: NodeJS.Timeout | undefined;
	const disarmLocal = () => {
		clearTimeout(localTimer);
		localTimer = undefined;
	};
	const armLocal = () => {
		disarmLocal();
		localTimer = setTimeout(() => {
			localTimer = undefined;
			streaming = false;
			void Promise.all([resyncMessages(), refreshState()]).then(() => emit({ type: "idle" }));
		}, LOCAL_COMMAND_MS);
		localTimer.unref();
	};

	/**
	 * The question pi is currently blocked on, if any. One at a time by
	 * construction: the dialog methods block the extension that called them,
	 * and the surface they drive is single.
	 */
	let pendingAsk: PiAsk | null = null;
	let askTimer: NodeJS.Timeout | undefined;
	const clearAsk = () => {
		clearTimeout(askTimer);
		if (!pendingAsk) return;
		pendingAsk = null;
		emit({ type: "ask", ask: null });
	};

	/*
	 * Frames drive two separate things, and they are kept separate: `toEvents`
	 * turns a frame into what the browser sees, and this switch does what the
	 * SERVER has to remember. Only the second half needs a live session, which
	 * is what lets a recorded transcript exercise the first (agent.test.ts).
	 */
	const unsubscribe = child.onFrame((frame) => {
		switch (frame.type) {
			case "agent_start":
				// The prompt DID reach the model, so this was not a local command.
				disarmLocal();
				streaming = true;
				break;

			case "message_end":
				if (isRecord(frame.message)) {
					// Appended BEFORE the event goes out: a client that refetches on
					// `message_done` must not read a transcript without it.
					messages = [...messages, frame.message];
					generation++;
					if (isRecord(frame.message.usage) && typeof frame.message.usage.totalTokens === "number") {
						contextTokens = frame.message.usage.totalTokens;
					}
				}
				break;

			case "agent_end":
				/*
				 * NOT the idle signal, and NOT `messages = frame.messages`. An
				 * `agent_end` may be followed by a retry, a compaction retry or a
				 * queued message, and its `messages` field carries only the run
				 * that just ended — assigning it truncates the transcript.
				 */
				void resyncMessages();
				break;

			case "compaction_end":
				// Compaction rewrites history into a summary. The event stream only
				// ever appends, so a resync is the only way the transcript learns
				// that older messages are gone — and the freed context only shows
				// up in the session's own accounting.
				void resyncMessages();
				void refreshState();
				break;

			case "extension_error":
				console.error(
					`[piw] pi extension error in ${String(frame.extensionPath)} (${String(frame.event)}):`,
					frame.error,
				);
				break;
		}

		for (const e of toEvents(frame)) {
			switch (e.type) {
				case "text":
				case "thinking":
					streaming = true;
					break;
				case "ask":
					pendingAsk = e.ask;
					clearTimeout(askTimer);
					/*
					 * pi resolves a timed dialog to its default on its own, and says
					 * nothing when it does. Without this the panel would sit there
					 * asking for an answer pi has stopped listening for.
					 */
					if (typeof frame.timeout === "number" && frame.timeout > 0) {
						askTimer = setTimeout(clearAsk, frame.timeout).unref();
					}
					break;
				case "idle":
					disarmLocal();
					streaming = false;
					break;
			}
			emit(e);
		}
	});

	return {
		get id() {
			return state.sessionId;
		},
		get file() {
			return state.sessionFile;
		},
		get cwd() {
			return cwd;
		},
		get isStreaming() {
			return streaming;
		},
		get model() {
			return model;
		},
		get supportsImages() {
			return supportsImages;
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		get thinkingLevels() {
			return thinkingLevels;
		},
		get contextTokens() {
			return contextTokens;
		},
		get contextWindow() {
			return contextWindow;
		},
		get commands() {
			return commands;
		},
		get ask() {
			return pendingAsk;
		},
		messages() {
			return stitch(messages.filter(isConversation).map(toPiMessage));
		},
		async prompt(text: string, images?: PiImage[]) {
			// Convert BEFORE sending: a bad attachment should surface as a rejected
			// prompt, not as a half-started turn that fails mid-flight.
			const attachments = images?.length ? images.map(toImageContent) : undefined;

			// streamingBehavior is REQUIRED while streaming or the command fails.
			const wasStreaming = streaming;
			await child.send<unknown>("prompt", {
				message: text,
				...(attachments ? { images: attachments } : {}),
				...(wasStreaming ? { streamingBehavior: "followUp" } : {}),
			});

			// The ack is acceptance, not completion. A `/command` may turn out to
			// be an extension command that runs here and now and never reaches the
			// model; `agent_start` is what distinguishes the two, and its absence
			// is what the timer waits for.
			streaming = true;
			if (!wasStreaming && text.trimStart().startsWith("/")) armLocal();
		},
		async refreshCommands() {
			commands = toCommands(await fetchCommands(child));
			return commands;
		},
		answerAsk(id: string, answer: AskAnswer) {
			/*
			 * The id is checked, not trusted. A stale one is routine — pi times a
			 * dialog out, or withdraws it, while the click is in flight — and
			 * posting it anyway would answer whatever question pi asked NEXT with
			 * the answer to the one before it.
			 */
			if (!pendingAsk || pendingAsk.id !== id) return false;
			child.post({ type: "extension_ui_response", id, ...answer });
			clearAsk();
			return true;
		},
		async abort() {
			/*
			 * The pending dialog is answered first: the extension is waiting on a
			 * response, and abandoning the panel would leave the browser showing a
			 * question for a turn that is over.
			 */
			if (pendingAsk) {
				child.post({ type: "extension_ui_response", id: pendingAsk.id, cancelled: true });
				clearAsk();
			}
			disarmLocal();
			await child.send("abort");
		},
		async compact() {
			/*
			 * The `compaction_end` frame drives the resync and the state refresh,
			 * so nothing is done with the summary the response carries — reading
			 * it here would be a second, racing copy of the same news.
			 */
			await child.send("compact");
		},
		async setModel(spec: string) {
			const slash = spec.indexOf("/");
			if (slash <= 0) throw new Error(`model must be "provider/id", got: ${spec}`);
			await child.send("set_model", {
				provider: spec.slice(0, slash),
				modelId: spec.slice(slash + 1),
			});
			// The new model brings its own reasoning levels, its own window, and
			// its own count of the same conversation.
			await refreshState();
		},
		async setThinkingLevel(level: string) {
			/*
			 * Validate HERE. `set_thinking_level` answers success for any string
			 * — "bogus" included — and the session is then left reporting no
			 * level at all, which is a worse state than the one the user asked
			 * for and is invisible until the next turn reasons differently.
			 */
			if (!thinkingLevels.includes(level)) {
				throw new Error(
					`unsupported thinking level "${level}" for ${model ?? "this model"}; expected one of ${thinkingLevels.join(", ")}`,
				);
			}
			await child.send("set_thinking_level", { level });
			thinkingLevel = (await fetchState(child)).thinkingLevel;
		},
		async setName(name: string) {
			const trimmed = name.trim();
			// pi rejects an empty name, and the error it returns says nothing
			// about which side sent it. Fail here, where the message can.
			if (!trimmed) throw new Error("session name cannot be empty");
			await child.send("set_session_name", { name: trimmed });
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose() {
			unsubscribe();
			listeners.clear();
			disarmLocal();
			clearTimeout(askTimer);
			child.close();
		},
	};
}

/**
 * The three questions that describe a session's model, asked together.
 *
 * `get_state` carries the resolved model object, including its accepted input
 * modalities — so image support comes from the session itself rather than from
 * a separate catalog lookup that could disagree with it. The thinking levels
 * and the context occupancy are their own commands in pi: the levels because
 * they are model-specific and pi resolves them, the occupancy because
 * `get_state` does not carry it at all.
 */
async function fetchState(child: RpcChild): Promise<SessionState> {
	const [data, levels, stats] = await Promise.all([
		child.send<unknown>("get_state"),
		child.send<unknown>("get_available_thinking_levels").catch(() => undefined),
		child.send<unknown>("get_session_stats").catch(() => undefined),
	]);
	if (!isRecord(data)) throw new Error("pi returned no session state");
	const m = isRecord(data.model) ? data.model : undefined;
	const provider = m && typeof m.provider === "string" ? m.provider : undefined;
	const id = m && typeof m.id === "string" ? m.id : undefined;

	/*
	 * A model with no reasoning support answers `["off"]`, which is not a
	 * choice — an empty list is how the UI knows not to offer the control.
	 */
	const all =
		isRecord(levels) && Array.isArray(levels.levels)
			? levels.levels.filter((l): l is string => typeof l === "string")
			: [];

	/*
	 * `contextUsage` is pi's live occupancy for this session, and the only
	 * number that follows a compaction down: the newest assistant `usage`
	 * still describes the prefix that was just folded away. Its `tokens` is
	 * null immediately after a compaction, until a fresh assistant response
	 * provides real usage.
	 */
	const usage = isRecord(stats) && isRecord(stats.contextUsage) ? stats.contextUsage : undefined;

	return {
		sessionId: String(data.sessionId ?? ""),
		sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : undefined,
		model: provider && id ? `${provider}/${id}` : undefined,
		// Absent metadata is treated as "no": offering an attach button that 400s
		// is worse than not offering one.
		supportsImages: Array.isArray(m?.input) && m.input.includes("image"),
		isStreaming: data.isStreaming === true,
		thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined,
		thinkingLevels: all.length > 1 ? all : [],
		contextWindow: typeof m?.contextWindow === "number" ? m.contextWindow : 0,
		contextTokens: typeof usage?.tokens === "number" ? usage.tokens : 0,
	};
}

async function fetchMessages(child: RpcChild): Promise<AgentMessage[]> {
	const data = await child.send<unknown>("get_messages");
	return isRecord(data) ? records(data.messages) : [];
}

async function fetchCommands(child: RpcChild): Promise<unknown> {
	const data = await child.send<unknown>("get_commands");
	return isRecord(data) ? data.commands : [];
}

/**
 * pi's UI requests, split into the two kinds this host can honour.
 *
 * These are not optional to handle: a blocking method (`confirm`, `input`,
 * `select`, `editor`) left unanswered stalls the extension that asked — which
 * from the browser is indistinguishable from a hung agent.
 *
 * Display-only methods (`setStatus`, `setWidget`, `setTitle`,
 * `set_editor_text`) are dropped: this UI has no status line or widget rail to
 * render them in, and pi expects no response to them. `notify` is handled by
 * the caller as a notice, not as a question.
 */
export function toAsk(frame: Record<string, unknown>): PiAsk | null {
	const id = frame.id;
	if (typeof id !== "string") return null;

	const title = typeof frame.title === "string" ? frame.title : undefined;
	const message = typeof frame.message === "string" ? frame.message : undefined;

	switch (frame.method) {
		case "select": {
			const options = (Array.isArray(frame.options) ? frame.options : [])
				.map((o) => ({ label: String(o) }))
				.filter((o) => o.label !== "");
			// A picker with nothing to pick cannot be answered, and offering an
			// empty list would be a dead end the turn never leaves.
			if (options.length === 0) return null;
			return { id, kind: "select", title, message, options };
		}
		case "confirm":
			return { id, kind: "confirm", title, message };
		case "input":
		case "editor":
			return {
				id,
				kind: "text",
				title,
				message,
				// `editor` prefills, `input` only hints; a placeholder typed into
				// the field would be submitted as if the user had written it.
				value: frame.method === "editor" && typeof frame.prefill === "string" ? frame.prefill : undefined,
				multiline: frame.method === "editor",
			};
		default:
			return null;
	}
}

/**
 * One pi frame, as the browser sees it.
 *
 * Pure on purpose: everything stateful — the transcript, the streaming flag,
 * the pending dialog, the resyncs — stays in `openSession`, so this mapping
 * can be replayed from a recorded transcript. Most frames produce nothing;
 * `message_update` produces at most one delta.
 *
 * What is deliberately dropped: `turn_start`/`turn_end` (a turn boundary the
 * UI has no row for), `message_start` (`message_end` carries the settled
 * message), `toolcall_*` deltas (the arguments arrive whole on
 * `tool_execution_start`), `queue_update`, and the display-only UI requests
 * `setStatus`, `setWidget`, `setTitle` and `set_editor_text`, which pi does
 * not expect an answer to and this UI has no rail to render.
 */
export function toEvents(frame: Record<string, unknown>): PiEvent[] {
	switch (frame.type) {
		case "message_update": {
			const ev = frame.assistantMessageEvent;
			if (!isRecord(ev)) return [];
			// Assembled from deltas: pi sends no cumulative snapshot on these
			// events at all.
			if (ev.type === "text_delta") return [{ type: "text", delta: String(ev.delta ?? "") }];
			if (ev.type === "thinking_delta") return [{ type: "thinking", delta: String(ev.delta ?? "") }];
			return [];
		}

		case "tool_execution_start":
			return [
				{
					type: "tool_start",
					id: String(frame.toolCallId ?? ""),
					name: String(frame.toolName ?? ""),
					args: frame.args,
				},
			];

		case "tool_execution_update":
			// `partialResult` is cumulative, so this REPLACES the card's output.
			return [
				{
					type: "tool_update",
					id: String(frame.toolCallId ?? ""),
					result: textOf(isRecord(frame.partialResult) ? frame.partialResult.content : undefined),
				},
			];

		case "tool_execution_end":
			return [
				{
					type: "tool_end",
					id: String(frame.toolCallId ?? ""),
					name: String(frame.toolName ?? ""),
					isError: Boolean(frame.isError),
					result: textOf(isRecord(frame.result) ? frame.result.content : undefined),
				},
			];

		case "message_end": {
			const m = frame.message;
			if (!isRecord(m) || !isConversation(m)) return [];
			/*
			 * IMPORTANT: a failed turn does NOT produce an error frame. A
			 * provider error (401, quota, overload) arrives as an assistant
			 * message with stopReason "error", empty content, and errorMessage
			 * set. Without this branch the UI renders a blank message and never
			 * learns anything went wrong.
			 */
			if (m.role === "assistant" && m.stopReason === "error") {
				const status = typeof m.errorStatus === "number" ? ` (HTTP ${m.errorStatus})` : "";
				return [
					{
						type: "error",
						message: `${String(m.errorMessage ?? "assistant turn failed")}${status}`,
					},
				];
			}
			return [{ type: "message_done", message: toPiMessage(m) }];
		}

		// THE idle signal. `agent_end` is not: a retry, a compaction retry or a
		// queued message may follow one.
		case "agent_settled":
			return [{ type: "idle" }];

		case "compaction_start":
			return [{ type: "notice", notice: { level: "info", text: "compacting the conversation…" } }];

		case "compaction_end": {
			const failure = typeof frame.errorMessage === "string" ? frame.errorMessage : "";
			return failure
				? [{ type: "notice", notice: { level: "error", text: `compaction failed: ${failure}` } }]
				: [];
		}

		case "auto_retry_start": {
			const attempt = typeof frame.attempt === "number" ? frame.attempt : 0;
			const max = typeof frame.maxAttempts === "number" ? frame.maxAttempts : 0;
			const delay = typeof frame.delayMs === "number" ? Math.round(frame.delayMs / 1000) : 0;
			const why = typeof frame.errorMessage === "string" ? `: ${frame.errorMessage}` : "";
			return [
				{ type: "notice", notice: { level: "warning", text: `retry ${attempt}/${max} in ${delay}s${why}` } },
			];
		}

		case "auto_retry_end":
			return frame.success === true
				? []
				: [
						{
							type: "notice",
							notice: {
								level: "error",
								text: `retries exhausted: ${String(frame.finalError ?? "unknown error")}`,
							},
						},
					];

		case "extension_ui_request": {
			/*
			 * A blocking request is a question for the USER, not something to
			 * answer on their behalf. It is held until the browser answers it.
			 *
			 * `notify` is the other half: fire-and-forget, and the only output an
			 * extension command produces, so dropping it is what makes such a
			 * command look like it never ran.
			 */
			if (frame.method === "notify") {
				const text = String(frame.message ?? "").trim();
				if (!text) return [];
				const level =
					frame.notifyType === "error" ? "error" : frame.notifyType === "warning" ? "warning" : "info";
				return [{ type: "notice", notice: { level, text } }];
			}
			const ask = toAsk(frame);
			return ask ? [{ type: "ask", ask }] : [];
		}

		default:
			return [];
	}
}
