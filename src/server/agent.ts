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
 *   - Independence. A child is not tied to this server's lifetime: see
 *     RpcChild. Restarting the server mid-turn loses nothing.
 *
 * The cost is that everything is async and nothing can be read out of a live
 * object, so this file keeps a small server-side mirror of session state
 * (messages, model, streaming) fed by the event stream. `messages()` stays
 * synchronous for callers; the mirror is what makes that possible.
 *
 * The mirror's blind spot: it reflects what THIS child emits. A session is
 * the FILE, and a second pi writing the same file — an orphan left by a port
 * takeover, an agent started by hand in the same cwd — produces turns no
 * event here ever carries, so `messages()` silently stops growing while the
 * file does not. `registry.refreshIfFileIsAhead` is the correction, and the
 * README section "A session is the file, not the child" records why it
 * compares timestamps rather than mtimes or counts.
 *
 * Everything arriving from the child is external input and is typed `unknown`,
 * narrowed through `isRecord` and explicit field checks. The wire is the one
 * place where a structural assumption turns into a silent rendering bug.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	readSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";

import { isRecord, records } from "./guards.js";
import { hunkFromWrite, hunksFromEdit, type Hunk } from "../shared/hunks.js";
import { fileURLToPath } from "node:url";
import { personalityPath, readRemind } from "./personality.js";
import { repairSessionFile } from "./repair.js";
import { sessionHeaderCwd } from "./sessions.js";
import { stateDir } from "./state.js";
import { ASK_ONLY } from "../shared/types.js";
import type {
	AskAnswer,
	PiAsk,
	PiBlock,
	PiCommand,
	PiEvent,
	PiImage,
	PiMessage,
	PiPartial,
} from "../shared/types.js";

// Re-exported for callers that already import from this module. `PiBlock` and
// `PiSessionInfo` are deliberately absent: everyone who needs them takes them
// from `shared/types.js` directly, and a re-export nobody imports is just a
// second name for the same type.
export type { AskAnswer, PiAsk, PiCommand, PiEvent, PiImage, PiMessage, PiPartial };

/**
 * A systemd user unit gets a minimal PATH that usually omits the directory an
 * `npm i -g` puts `pi` in, so "pi" on PATH is not a safe assumption in the
 * deployment this project is built for. PWI_PI_BIN is the escape hatch, and
 * the ENOENT message below names it.
 */
export const PI_BIN = process.env.PWI_PI_BIN ?? "pi";

/**
 * pi emits nothing unprompted at startup — no ready frame, no protocol
 * negotiation (docs/pi-facts.md §0.2). Readiness is therefore the first
 * successful `get_state`, which answered in 3 ms on a warm machine. The
 * generous ceiling is for a cold Pi 5 doing package and skill discovery.
 */
const READY_TIMEOUT_MS = 60_000;

/** Grace between SIGTERM and SIGKILL when disposing a child. */
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

/**
 * What an image-only prompt says instead of nothing.
 *
 * pi ALWAYS prepends a text block to a user turn — `agent-session.ts` builds
 * `[{type:"text", text}, ...images]` whether or not `text` is empty — and a
 * block with `text: ""` is a request the Anthropic API rejects outright:
 * `400 invalid_request_error: messages: text content blocks must be
 * non-empty`. pi's own anthropic provider filters blank blocks out on the way
 * to the wire; a provider PACKAGE need not, and `pi-sub-anthropic` does not.
 *
 * Worse than one failed turn: the empty block is persisted before the request
 * is made, so every later prompt replays it and the session file is bricked
 * exactly the way a dangling tool call bricks one. Both are healed here.
 *
 * So a caption, not an empty string. It is what the user meant — "look at
 * this" — and it costs a handful of tokens.
 */
const IMAGE_ONLY_PROMPT = "(see attached image)";

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
		const clean = (t: string) => (t.endsWith(ASK_ONLY) ? t.slice(0, -ASK_ONLY.length) : t);
		if (typeof m.content === "string") {
			blocks.push({ kind: "text", text: clean(m.content) });
		} else {
			for (const c of records(m.content)) {
				if (c.type === "text") blocks.push({ kind: "text", text: clean(String(c.text ?? "")) });
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
 * observed on a machine running 0.86.0.
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

	/** True when no partial line is buffered. */
	empty(): boolean {
		return this.buf.length === 0;
	}

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
 * Where live children are recorded: one directory each, holding the stdin
 * FIFO (`in`), stdout and stderr files (`out`, `err`) and `meta.json`.
 *
 * Keyed by port because the port is the lock: only one pwi can hold it, so
 * only one pwi ever adopts these children. A dev and a production pwi on
 * different ports share the state directory and must not steal each other's.
 */
function childrenDir(): string {
	return join(stateDir(), "children", process.env.PWI_PORT ?? "8890");
}

/**
 * Request ids carry a per-process prefix. An adopted child's `out` file still
 * holds the previous server's responses, and its `r3` must not resolve ours.
 */
const BOOT = randomUUID().slice(0, 8);

/** How often an adopted child is checked for exit, and `out` re-read in case a watch event was missed. */
const POLL_MS = 1_000;

/**
 * `out` is cut back to zero at a settle once it passes this. Without a cut it
 * grows by every delta of every turn for the life of the child.
 */
const TRUNCATE_AT = 256 * 1024;

interface Meta {
	pid: number;
	/** False for throwaway children (askOnce): never adopted, killed on sight. */
	keep: boolean;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Kill pi and whatever tools it is running: `detached` made it a process-group leader. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// Already gone.
	}
}

/**
 * One pi child process, with request/response correlation.
 *
 * Responses are matched on `id`, never on arrival order: commands are
 * dispatched concurrently by the server, so a later one can answer first.
 *
 * The child OUTLIVES this server. Its stdin is a FIFO it opened read-write
 * itself, so it holds a writer of its own and never reads EOF when we go; its
 * stdout and stderr are plain files; it runs in its own process group. A
 * restarted server (a `--watch` reload, a crash, a port takeover) finds it
 * through `meta.json` and `adopt`s it mid-turn. Pipes would tie pi's lifetime
 * to ours: pi exits 1.3s after stdin EOF (docs/pi-facts.md).
 */
class RpcChild {
	private readonly pending = new Map<string, Pending>();
	private readonly frameListeners = new Set<(frame: Record<string, unknown>) => void>();
	private readonly reader: FrameReader;
	private seq = 0;
	private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	private exitListeners = new Set<(message: string) => void>();
	/** Non-response frames that arrived before `release`. Null once released. */
	private held: Record<string, unknown>[] | null = [];
	private offset: number;
	private settled = false;
	private closing = false;
	private readonly readFd: number;
	private readonly stdin: Socket;
	private readonly watcher: FSWatcher;
	private readonly poll: NodeJS.Timeout;

	private constructor(
		readonly dir: string,
		readonly pid: number,
		writeFd: number,
		offset: number,
		/** Present when this process spawned the child and so gets its exit code. */
		proc?: ChildProcess,
	) {
		this.reader = new FrameReader(
			(frame) => this.dispatch(frame),
			(message) => console.error("[pwi] rpc transport:", message),
		);
		this.offset = offset;
		this.readFd = openSync(join(dir, "out"), "r+");
		this.stdin = new Socket({ fd: writeFd, readable: false, writable: true });
		// EPIPE: nobody reads the FIFO any more, so pi is gone.
		this.stdin.on("error", () => this.checkExit());
		this.watcher = watch(join(dir, "out"), () => this.pump());
		this.watcher.unref();
		this.poll = setInterval(() => {
			this.pump();
			if (!proc) this.checkExit();
		}, POLL_MS);
		this.poll.unref();
		proc?.once("exit", (code, signal) => this.onExit(code, signal));
	}

	static async start(args: string[], cwd: string, keep = true): Promise<RpcChild> {
		const dir = join(childrenDir(), randomUUID());
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const fifo = join(dir, "in");
		execFileSync("mkfifo", ["-m", "600", fifo]);
		// O_RDWR never blocks on a FIFO, and it is what pi inherits as fd 0.
		const rw = openSync(fifo, constants.O_RDWR);
		const out = openSync(join(dir, "out"), "a", 0o600);
		const err = openSync(join(dir, "err"), "a", 0o600);
		let proc: ChildProcess;
		try {
			proc = spawn(PI_BIN, args, {
				cwd,
				stdio: [rw, out, err],
				detached: true,
				// Inherit the environment: pi resolves credentials, settings, and the
				// model catalog from it.
				env: process.env,
			});
		} finally {
			closeSync(out);
			closeSync(err);
		}
		// A reader exists (rw), so a non-blocking write open cannot fail with ENXIO.
		const writeFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		closeSync(rw);

		const spawned = await new Promise<number>((resolve, reject) => {
			if (proc.pid) return resolve(proc.pid);
			proc.once("error", (e: NodeJS.ErrnoException) =>
				reject(
					e.code === "ENOENT"
						? new Error(
								`cannot run "${PI_BIN}": not found on PATH. Set PWI_PI_BIN to its absolute path (a systemd user unit does not read your shell profile).`,
							)
						: e,
				),
			);
		}).catch((e: Error) => {
			closeSync(writeFd);
			rmSync(dir, { recursive: true, force: true });
			throw e;
		});
		proc.unref();
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ pid: spawned, keep } satisfies Meta));

		const child = new RpcChild(dir, spawned, writeFd, 0, proc);

		/*
		 * Readiness is a round trip, not a frame to wait for. Early exit has to be
		 * raced against it: a child that dies during package installation would
		 * otherwise leave `get_state` pending until the timeout, reporting a
		 * timeout instead of the real reason.
		 */
		const failed = new Promise<never>((_resolve, reject) => {
			child.exitListeners.add((message) => reject(new Error(message)));
		});
		const timeout = new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`pi did not answer within ${READY_TIMEOUT_MS / 1000}s`)),
				READY_TIMEOUT_MS,
			);
			timer.unref();
		});

		try {
			await Promise.race([child.send("get_state"), failed, timeout]);
		} catch (err) {
			child.kill();
			throw err;
		}
		return child;
	}

	/**
	 * Take over a child a previous server left running, or clean up after it.
	 *
	 * Identity is checked, not assumed: the pid must be alive AND its fd 0 must
	 * be this record's FIFO, so a recycled pid is never adopted or killed.
	 */
	static adopt(dir: string): RpcChild | undefined {
		let meta: Meta;
		try {
			meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as Meta;
		} catch {
			// Died between spawn and meta write, or not ours.
			rmSync(dir, { recursive: true, force: true });
			return undefined;
		}
		const fifo = join(dir, "in");
		let ours = false;
		try {
			ours = alive(meta.pid) && readlinkSync(`/proc/${meta.pid}/fd/0`) === fifo;
		} catch {
			// /proc entry vanished: exited.
		}
		if (ours && !meta.keep) killGroup(meta.pid, "SIGTERM");
		if (!ours || !meta.keep) {
			rmSync(dir, { recursive: true, force: true });
			return undefined;
		}
		const writeFd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
		return new RpcChild(dir, meta.pid, writeFd, replayFrom(readFileSync(join(dir, "out"))));
	}

	/** Every live child a previous server left in `childrenDir()`. */
	static adoptAll(): RpcChild[] {
		let names: string[];
		try {
			names = readdirSync(childrenDir());
		} catch {
			return [];
		}
		return names.flatMap((n) => {
			try {
				return RpcChild.adopt(join(childrenDir(), n)) ?? [];
			} catch (err) {
				console.error(`[pwi] could not adopt pi child ${n}:`, err);
				return [];
			}
		});
	}

	/** The directory pi is running in, from /proc: an adopted child has no spawn call to ask. */
	cwd(): string | undefined {
		try {
			return readlinkSync(`/proc/${this.pid}/cwd`);
		} catch {
			return undefined;
		}
	}

	onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	/**
	 * Deliver the frames held since the child was opened. Until then nothing
	 * listens, and an adopted child's replay (the in-flight message, a pending
	 * question) would fall on the floor. Returns how many were held.
	 */
	release(): number {
		const held = this.held ?? [];
		this.held = null;
		for (const frame of held) this.deliver(frame);
		return held.length;
	}

	/** Read `out` from where we are to its end. Sync, so frames stay in order. */
	private pump(): void {
		if (this.closing && this.exited) return;
		const buf = Buffer.allocUnsafe(64 * 1024);
		for (;;) {
			let n: number;
			try {
				n = readSync(this.readFd, buf, 0, buf.length, this.offset);
			} catch {
				return; // fd closed by detach/exit
			}
			if (n <= 0) break;
			this.offset += n;
			this.reader.push(Buffer.from(buf.subarray(0, n)));
		}
		/*
		 * ponytail: a frame pi writes between this read and the truncate is lost.
		 * The window is microseconds and only open while idle with nothing asked,
		 * when pi has nothing to say. A broker that owns the pipe removes it.
		 */
		if (this.settled && this.pending.size === 0 && this.reader.empty() && this.offset > TRUNCATE_AT) {
			ftruncateSync(this.readFd, 0);
			this.offset = 0;
			this.settled = false;
		}
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
			// whose caller has already gone — or to a previous server's.
			if (frame.success !== true && !(id && !id.startsWith(`r${BOOT}-`))) {
				console.error(`[pwi] pi ${String(frame.command)} failed:`, String(frame.error ?? ""));
			}
			return;
		}

		if (frame.type === "agent_settled") this.settled = true;
		else if (frame.type === "agent_start") this.settled = false;

		if (this.held) this.held.push(frame);
		else this.deliver(frame);
	}

	private deliver(frame: Record<string, unknown>): void {
		for (const listener of [...this.frameListeners]) {
			try {
				listener(frame);
			} catch (err) {
				console.error("[pwi] frame listener threw:", err);
			}
		}
	}

	send<T = unknown>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
		if (this.exited) {
			return Promise.reject(new Error(this.exitMessage(this.exited.code, this.exited.signal)));
		}

		const id = `r${BOOT}-${++this.seq}`;
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

	private checkExit(): void {
		if (!this.exited && !alive(this.pid)) this.onExit(null, null);
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.pump(); // the last frames before it died
		this.exited = { code, signal };
		const message = this.exitMessage(code, signal);
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(new Error(message));
		}
		for (const l of this.exitListeners) l(message);
		this.stop();
		rmSync(this.dir, { recursive: true, force: true });
	}

	private exitMessage(code: number | null, signal: NodeJS.Signals | null): string {
		const how = signal ? `signal ${signal}` : code === null ? "unknown status" : `code ${code}`;
		let tail = "";
		try {
			tail = readFileSync(join(this.dir, "err"), "utf8").slice(-STDERR_KEEP).trim().split("\n").slice(-6).join("\n");
		} catch {
			// Already cleaned up.
		}
		return tail ? `pi exited (${how}):\n${tail}` : `pi exited (${how})`;
	}

	/** Release our handles on the child. Idempotent. */
	private stop(): void {
		clearInterval(this.poll);
		this.watcher.close();
		this.stdin.destroy();
		try {
			closeSync(this.readFd);
		} catch {
			// Already closed.
		}
	}

	private kill(): void {
		killGroup(this.pid, "SIGTERM");
		const hard = setTimeout(() => killGroup(this.pid, "SIGKILL"), DISPOSE_GRACE_MS);
		hard.unref();
	}

	/**
	 * End the child. SIGTERM to its group (pi and any tool it is running), then
	 * SIGKILL: a wedged child must not outlive its session and hold a JSONL open.
	 * There is no stdin EOF to send: pi holds its own writer on the FIFO.
	 */
	close(): void {
		if (this.exited || this.closing) return;
		this.closing = true;
		this.kill();
		// A child we did not spawn has no exit event; the poll is stopped by
		// nothing but the exit it is waiting for.
	}

	/**
	 * Let go without killing: the next server adopts the child where we left it.
	 * Used at shutdown for a session mid-turn.
	 */
	detach(): void {
		if (this.exited) return;
		this.stop();
	}
}

/**
 * Where an adopted child's replay starts: just past the last `message_end`.
 *
 * Everything before it is in `get_messages`. Everything after it is what
 * `get_messages` cannot show — the in-flight message's deltas, the tools
 * running, a question pi is blocked on — and replaying it rebuilds exactly
 * that. Exported for the test.
 */
export function replayFrom(out: Buffer): number {
	let start = 0;
	let after = 0;
	while (start < out.length) {
		const nl = out.indexOf(0x0a, start);
		if (nl === -1) break;
		const line = out.subarray(start, nl);
		if (line.includes('"message_end"')) {
			try {
				if ((JSON.parse(line.toString("utf8")) as { type?: unknown }).type === "message_end") after = nl + 1;
			} catch {
				// Not a frame.
			}
		}
		start = nl + 1;
	}
	return after;
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
	/**
	 * Every change this session's agent made to a file, oldest first, for
	 * diff tabs. Already applied to disk: pi's edit tool writes during
	 * execution, so these are changes to review, not proposals to approve.
	 */
	readonly hunks: Hunk[];
	/** Record a review decision. False if `id` is not a hunk of this session. */
	setHunkState(id: string, state: Hunk["state"]): boolean;
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
	/** The first subscriber also receives the frames held since open (see RpcChild.release). */
	subscribe(listener: (e: PiEvent) => void): () => void;
	dispose(): void;
	/** Let go of the child without killing it, so the next server adopts it. */
	detach(): void;
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
/** Loaded by pi (with its own TS loader), never imported here. */
const REMIND_EXTENSION = fileURLToPath(new URL("./remind-extension.ts", import.meta.url));

export function spawnArgs(opts: {
	file?: string;
	model?: string;
	personality?: string;
	remind?: boolean;
}): string[] {
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
	// The same file again at the end of each request; see remind-extension.ts.
	if (opts.personality && opts.remind) {
		args.push("-e", REMIND_EXTENSION, "--pwi-remind", opts.personality);
	}
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
	const child = await RpcChild.start(["--mode", "rpc", "--no-session"], cwd, false);
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
		/*
		 * Before the child opens it, never after: pi reads history from this file
		 * once at startup and replays it to the provider on every turn, so a turn
		 * with an empty text block in it fails forever otherwise. See repair.ts
		 * for why that block exists and why only a file rewrite reaches it.
		 */
		repairSessionFile(opts.file);
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
		spawnArgs({ file: opts.file, model: opts.model, personality, remind: readRemind() }),
		cwd,
	);
	return wrap(child, cwd);
}

/**
 * Every session a previous server left running, mid-turn or not. Called once
 * at startup, before anything can open the same file a second time.
 */
export async function adoptSessions(fallbackCwd: string): Promise<PiSession[]> {
	const sessions: PiSession[] = [];
	for (const child of RpcChild.adoptAll()) {
		try {
			sessions.push(await wrap(child, child.cwd() ?? fallbackCwd));
		} catch (err) {
			console.error(`[pwi] adopted pi child ${child.pid} did not answer:`, err);
			child.detach();
		}
	}
	return sessions;
}

/** The session mirror around a live child, spawned here or adopted. */
async function wrap(child: RpcChild, cwd: string): Promise<PiSession> {
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
	 * Hunks this session's agent produced, oldest first, for diff tabs.
	 *
	 * Server-side because the edit has ALREADY HAPPENED by the time anyone sees
	 * it: pi's edit tool writes during execution and this server installs no
	 * `tool_call` gate, so the pane reviews changes on disk rather than approving
	 * proposals. That makes the pre-edit content something only this process can
	 * observe, and only in the window between `tool_execution_start` and the
	 * tool actually writing — which is why it is captured here and not derived
	 * later from a diff.
	 */
	const hunks: Hunk[] = [];
	/**
	 * What an in-flight edit needs, keyed by tool call id, until its end frame.
	 *
	 * The ARGS are held here and not read from the end frame because
	 * `tool_execution_end` does not carry them — verified against a live child:
	 * it has `toolCallId`, `toolName`, `result` and `isError`, and nothing else.
	 * `tool_execution_start` is the only frame with the arguments, and also the
	 * only moment the pre-edit content still exists, so both are captured there.
	 */
	const preEdit = new Map<string, { before: string | null; args: Record<string, unknown> }>();

	/**
	 * The question pi is currently blocked on, if any. One at a time by
	 * construction: the dialog methods block the extension that called them,
	 * and the surface they drive is single.
	 */
	let pendingAsk: PiAsk | null = null;
	/** True while held frames are replayed: see `tool_execution_start`. */
	let replaying = false;
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

			/*
			 * This fires BEFORE the tool runs, which is the only moment the
			 * pre-edit content of the file still exists. Read it now or lose it:
			 * once `edit` has written, nothing on this machine remembers what was
			 * there, and a diff computed afterwards could only guess at which of
			 * the agent's edits produced which change.
			 *
			 * Synchronous on purpose. An async read would race the tool's own
			 * write and could return the post-edit content, silently producing a
			 * hunk whose "before" is its "after".
			 */
			case "tool_execution_start": {
				// A replayed start is from before a restart: the file may already
				// hold the edit, and a "before" read now would be its "after".
				if (replaying) break;
				const tool = String(frame.toolName ?? "");
				if (tool !== "edit" && tool !== "write") break;
				const args = isRecord(frame.args) ? frame.args : {};
				if (typeof args.path !== "string") break;
				let before: string | null;
				try {
					before = readFileSync(args.path, "utf8");
				} catch {
					// Absent is meaningful, not an error: `write` creating a new file
					// records null, which is what makes "did not exist" distinguishable
					// from "existed empty" when the change is reverted.
					before = null;
				}
				preEdit.set(String(frame.toolCallId ?? ""), { before, args });
				break;
			}

			/*
			 * Hunks are built here, from the tool's OWN ARGUMENTS rather than from
			 * a diff of before and after. The agent already said what it meant to
			 * change; re-diffing would split one intended edit across two hunks or
			 * merge two unrelated ones, and show a change nobody expressed.
			 */
			case "tool_execution_end": {
				const id = String(frame.toolCallId ?? "");
				const pending = preEdit.get(id);
				if (!pending) break;
				preEdit.delete(id);
				// A failed edit changed nothing, so there is nothing to review.
				if (frame.isError === true) break;
				const { before, args } = pending;
				if (typeof args.path !== "string") break;

				if (String(frame.toolName ?? "") === "write") {
					if (typeof args.content !== "string") break;
					hunks.push(hunkFromWrite(id, args.path, before, args.content));
				} else {
					// An `edit` against a file that could not be read has no "before"
					// to anchor against, so its hunks would be unrevertable.
					if (before === null) break;
					const edits = records(args.edits).flatMap((e) =>
						typeof e.oldText === "string" && typeof e.newText === "string"
							? [{ oldText: e.oldText, newText: e.newText }]
							: [],
					);
					if (edits.length === 0) break;
					hunks.push(...hunksFromEdit(id, args.path, before, edits));
				}
				break;
			}

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
					`[pwi] pi extension error in ${String(frame.extensionPath)} (${String(frame.event)}):`,
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
		get hunks() {
			return hunks;
		},
		/**
		 * Record a review decision. The STATE is all that is stored here; the
		 * bytes are written by the caller through files.ts, because this module
		 * speaks to pi and nothing else.
		 */
		setHunkState(id: string, state: Hunk["state"]): boolean {
			const hunk = hunks.find((h) => h.id === id);
			if (!hunk) return false;
			hunk.state = state;
			return true;
		},
		messages() {
			return stitch(messages.filter(isConversation).map(toPiMessage));
		},
		async prompt(text: string, images?: PiImage[]) {
			// Convert BEFORE sending: a bad attachment should surface as a rejected
			// prompt, not as a half-started turn that fails mid-flight.
			const attachments = images?.length ? images.map(toImageContent) : undefined;

			// An image with no words is a legitimate prompt in the composer and an
			// invalid request on the wire, because pi persists and replays the empty
			// text block it builds around it (see IMAGE_ONLY_PROMPT). Caption it.
			const message = text.trim() ? text : attachments ? IMAGE_ONLY_PROMPT : text;

			// streamingBehavior is REQUIRED while streaming or the command fails.
			const wasStreaming = streaming;
			await child.send<unknown>("prompt", {
				message,
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
			replaying = true;
			const held = child.release();
			replaying = false;
			// A held `message_end` may already be in the list get_messages returned.
			if (held > 0) void resyncMessages();
			return () => listeners.delete(listener);
		},
		dispose() {
			unsubscribe();
			listeners.clear();
			disarmLocal();
			clearTimeout(askTimer);
			child.close();
		},
		detach() {
			unsubscribe();
			listeners.clear();
			disarmLocal();
			clearTimeout(askTimer);
			child.detach();
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
