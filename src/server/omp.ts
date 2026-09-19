/**
 * omp.ts — THE RPC BOUNDARY.
 *
 * The only file that spawns or speaks to `omp`. One `omp --mode rpc-ui` child
 * process per open session, driven over newline-delimited JSON on stdio.
 *
 * This replaced an in-process SDK import, and the reason is worth recording.
 * The SDK's churn is concentrated in *construction* — credentials, model
 * registry, session manager — and that boilerplate was rewritten twice
 * upstream while the agent's actual behavior stayed put. The RPC surface is a
 * documented, versioned wire contract instead: commands in, frames out. It
 * also buys two things an in-process session cannot:
 *
 *   - Isolation. A tool that segfaults its host, or an OOM inside one
 *     conversation, takes down one child rather than the whole server and
 *     every other session with it.
 *   - Restartability. Conversation state lives in omp's own JSONL under
 *     ~/.omp/agent/sessions/<cwd>/, so a child is disposable: `-r <file>`
 *     rehydrates one for the cost of a spawn, preserving both the session id
 *     and the file (verified). Restarting this server loses at most an
 *     in-flight turn, not the work.
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
import { existsSync } from "node:fs";
import type { Readable, Writable } from "node:stream";

import { isRecord, records } from "./guards.js";
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
	PiSubagent,
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
	PiSubagent,
};

/**
 * A systemd user unit gets a minimal PATH that usually omits ~/.local/bin, so
 * "omp" on PATH is not a safe assumption in the deployment this project is
 * built for. PIW_OMP_BIN is the escape hatch, and the ENOENT message below
 * names it.
 */
export const OMP_BIN = process.env.PIW_OMP_BIN ?? "omp";

/**
 * Approvals arrive as `extension_ui_request` confirms, which this host now
 * puts to the user (see `toAsk`), so `always-ask` and `write` are usable
 * here rather than a guaranteed stall. `yolo` stays the default because the
 * thing this host is FOR is a session that keeps running with no browser
 * attached, and an approval nobody is there to answer blocks the turn until
 * somebody opens the page.
 */
const APPROVAL_MODE = process.env.PIW_APPROVAL_MODE ?? "yolo";

/** omp does extension/skill discovery before the ready frame; a cold Pi 5 is slow. */
const READY_TIMEOUT_MS = 60_000;

/** Grace between "close stdin" and SIGTERM when disposing a child. */
const DISPOSE_GRACE_MS = 5_000;

/**
 * How long after a local slash command's last output line to re-read the
 * session. Long enough to cover a multi-line answer, short enough that the
 * pane catches up before the user looks away.
 */
const COMMAND_SETTLE_MS = 400;

/**
 * How long to let subagent frames pile up before re-reading the roster. Long
 * enough to fold a burst of progress from a wide fan-out into one read, short
 * enough that a child appearing still feels immediate.
 */
const SUBAGENT_SETTLE_MS = 150;

/** Documented v2 ceiling for a reassembled logical frame. */
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

/**
 * MIME types omp can sniff and forward. Anything else is rejected at the door
 * rather than discovered as a provider 400 three layers down.
 */
const SUPPORTED_IMAGE_MIME: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
	"image/bmp": true,
};

/** Hard ceiling on a single decoded attachment. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** How much child stderr to keep for error messages. Auth failures land here. */
const STDERR_KEEP = 4_000;

/** One message as omp models it. Field access goes through the shared guards. */
type OmpMessage = Record<string, unknown>;

export function emptyPartial(): PiPartial {
	return { text: "", thinking: "", tools: [] };
}

// ---------------------------------------------------------------------------
// Conversion helpers
//
// The message and event shapes are identical to the in-process SDK's — same
// roles, same content blocks, same `toolCallId`/`toolName`/`args` fields —
// because RPC mode forwards the very same objects. These are ported from the
// SDK boundary they replaced, and were verified against live frames.
// ---------------------------------------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return records(content)
		.map((c) =>
			c.type === "text" ? String(c.text ?? "") : c.type === "image" ? "[image]" : "",
		)
		.join("");
}

/**
 * Validate one pasted image.
 *
 * Note what is deliberately NOT here: resizing. The in-process version shrank
 * screenshots through the SDK's Photon/WASM `resizeImage` before handing them
 * over. Across RPC the image is omp's to normalize for the provider, and the
 * only way to keep resizing here would be a native image dependency — a large
 * cost for a step the agent already owns. So this validates (type, non-empty,
 * ceiling) and passes the bytes through. A rejection here is reportable to the
 * user; a provider 400 is not.
 */
function toImageContent(img: PiImage): { type: "image"; data: string; mimeType: string } {
	if (!SUPPORTED_IMAGE_MIME[img.mimeType]) {
		throw new Error(`unsupported image type: ${img.mimeType}`);
	}

	const bytes = Buffer.from(img.data, "base64");
	if (bytes.length === 0) throw new Error("image is empty or not valid base64");
	if (bytes.length > MAX_IMAGE_BYTES) {
		throw new Error(
			`image is ${Math.round(bytes.length / 1024 / 1024)}MB, limit is 20MB`,
		);
	}

	return { type: "image", data: img.data, mimeType: img.mimeType };
}

/**
 * Flatten one omp message into our shape. Tool CALLS live on assistant
 * messages and tool RESULTS arrive as separate `toolResult` messages; we keep
 * them separate here and let the caller stitch, which keeps this pure.
 */
export function toPiMessage(m: OmpMessage): PiMessage {
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
	 * Summaries keep their text in `summary`, NOT in `content`: a
	 * compactionSummary from get_messages has no content field at all, only
	 * `summary`/`shortSummary`/`tokensBefore`/`tokensAfter`/`method`. Reading
	 * content here rendered the compaction boundary as an empty row.
	 *
	 * compactionSummary also gets its own role, so the UI can draw the
	 * boundary it is; branchSummary / bashExecution / custom stay text.
	 */
	const text = typeof m.summary === "string" ? m.summary : textOf(m.content);
	const role = m.role === "compactionSummary" ? "compaction" : "other";
	return { role, blocks: [{ kind: "text", text }], timestamp };
}

/**
 * Narrow omp's command catalog to what the composer's picker shows.
 *
 * Dropped on the way through: `source`, and the per-subcommand `usage`
 * strings. The full catalog is ~14 KB of JSON for 45 commands and rides in
 * every snapshot, and neither field has a place in a two-line row.
 *
 * A command with no name is skipped rather than rendered: it would be an
 * empty row that inserts nothing.
 */
export function toCommands(list: unknown): PiCommand[] {
	const out: PiCommand[] = [];
	for (const c of records(list)) {
		const name = typeof c.name === "string" ? c.name : "";
		if (!name) continue;

		const aliases = Array.isArray(c.aliases)
			? c.aliases.filter((a): a is string => typeof a === "string")
			: [];
		const subcommands = records(c.subcommands)
			.map((s) => ({
				name: typeof s.name === "string" ? s.name : "",
				description: typeof s.description === "string" ? s.description : undefined,
			}))
			.filter((s) => s.name);
		const hint =
			isRecord(c.input) && typeof c.input.hint === "string" ? c.input.hint : undefined;

		out.push({
			name,
			...(typeof c.description === "string" ? { description: c.description } : {}),
			...(hint ? { hint } : {}),
			...(aliases.length > 0 ? { aliases } : {}),
			...(subcommands.length > 0 ? { subcommands } : {}),
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
 * blocks"), so the session file is bricked, not just the one turn. Neither omp
 * nor the provider heals this; we do, at open time.
 */
export function healDanglingToolCalls(messages: OmpMessage[]): OmpMessage[] {
	const answered = new Set<unknown>();
	for (const m of messages) {
		if (m.role === "toolResult") answered.add(m.toolCallId);
	}

	const out: OmpMessage[] = [];
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

interface ChunkAssembly {
	chunkId: string;
	count: number;
	byteLength: number;
	next: number;
	parts: Buffer[];
	size: number;
}

/**
 * Splits the child's stdout into logical JSON frames.
 *
 * Two things here are not optional:
 *
 * 1. Split on raw 0x0A BYTES, not on decoded string chunks. A frame can be a
 *    megabyte of UTF-8 and arrive in arbitrary pieces; decoding each piece
 *    independently would corrupt any multi-byte character straddling the
 *    boundary. 0x0A never appears inside a multi-byte UTF-8 sequence, so
 *    splitting first and decoding whole lines is safe.
 *
 * 2. Reassemble `rpc_chunk` sequences. Protocol v1 caps a physical stdout
 *    frame at 1 MiB and truncates past it; real tool results (a big file read,
 *    a long diff) clear that easily. v2 splits oversized frames into a
 *    contiguous base64 chunk sequence, and the contract is strict: chunks
 *    arrive uninterrupted, in index order, and the decoded byte length must
 *    match. Anything else means we are looking at interleaved or dropped
 *    output, and quietly concatenating it would hand malformed JSON to the UI.
 */
class FrameReader {
	// Explicit `ArrayBufferLike`: under the ES2024 lib, `Buffer.concat` is
	// typed as the general buffer and `Buffer.alloc` as the narrow one.
	private buf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	private assembly: ChunkAssembly | null = null;

	constructor(
		private readonly onFrame: (frame: Record<string, unknown>) => void,
		private readonly onProtocolError: (message: string) => void,
	) {}

	push(data: Buffer): void {
		this.buf = this.buf.length === 0 ? data : Buffer.concat([this.buf, data]);
		let nl: number;
		while ((nl = this.buf.indexOf(0x0a)) !== -1) {
			const line = this.buf.subarray(0, nl);
			this.buf = this.buf.subarray(nl + 1);
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

		if (parsed.type !== "rpc_chunk") {
			if (this.assembly) {
				// An interleaved frame breaks the sequence contract outright.
				this.onProtocolError(
					`chunk sequence ${this.assembly.chunkId} interrupted by a ${String(parsed.type)} frame`,
				);
				this.assembly = null;
			}
			this.onFrame(parsed);
			return;
		}

		this.chunk(parsed);
	}

	private chunk(frame: Record<string, unknown>): void {
		const { chunkId, index, count, byteLength, data } = frame;
		if (
			typeof chunkId !== "string" ||
			typeof index !== "number" ||
			typeof count !== "number"
		) {
			this.onProtocolError("malformed rpc_chunk header");
			this.assembly = null;
			return;
		}

		if (!this.assembly) {
			if (index !== 0) {
				this.onProtocolError(`rpc_chunk ${chunkId} started at index ${index}`);
				return;
			}
			const expected = typeof byteLength === "number" ? byteLength : -1;
			if (expected < 0 || expected > MAX_REASSEMBLED_BYTES) {
				this.onProtocolError(
					`frame of ${expected} bytes exceeds the ${MAX_REASSEMBLED_BYTES} byte reassembly limit`,
				);
				return;
			}
			this.assembly = {
				chunkId,
				count,
				byteLength: expected,
				next: 0,
				parts: [],
				size: 0,
			};
		}

		const a = this.assembly;
		if (chunkId !== a.chunkId || index !== a.next || count !== a.count) {
			this.onProtocolError(`rpc_chunk ${chunkId}#${index} out of sequence`);
			this.assembly = null;
			return;
		}

		const part = Buffer.from(String(data ?? ""), "base64");
		a.parts.push(part);
		a.size += part.length;
		a.next++;
		if (a.size > MAX_REASSEMBLED_BYTES) {
			this.onProtocolError(`chunk sequence ${chunkId} overflowed the reassembly limit`);
			this.assembly = null;
			return;
		}
		if (a.next < a.count) return;

		this.assembly = null;
		if (a.size !== a.byteLength) {
			this.onProtocolError(
				`chunk sequence ${chunkId} reassembled to ${a.size} bytes, expected ${a.byteLength}`,
			);
			return;
		}

		// Strict UTF-8: a replacement character here means we mis-assembled, and
		// silently shipping mojibake into the transcript is worse than an error.
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(a.parts, a.size),
			);
		} catch {
			this.onProtocolError(`chunk sequence ${chunkId} is not valid UTF-8`);
			return;
		}

		let reassembled: unknown;
		try {
			reassembled = JSON.parse(text);
		} catch {
			this.onProtocolError(`chunk sequence ${chunkId} did not reassemble into JSON`);
			return;
		}
		if (isRecord(reassembled)) this.onFrame(reassembled);
		else this.onProtocolError(`chunk sequence ${chunkId} reassembled into a non-object`);
	}
}

interface Pending {
	command: string;
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
}

/**
 * One omp child process, with request/response correlation.
 *
 * Responses are matched on `id`, never on arrival order: commands are
 * dispatched concurrently by the server, so a later one can answer first.
 */
class RpcChild {
	private readonly pending = new Map<string, Pending>();
	private readonly frameListeners = new Set<(frame: Record<string, unknown>) => void>();
	/**
	 * Ids of accepted prompts. `prompt` acks immediately and MAY emit a later
	 * failure carrying the same id; without this set that late response has no
	 * pending entry and would be dropped, which is exactly the case where the
	 * user is owed an error.
	 */
	private readonly settled = new Set<string>();
	private readonly reader: FrameReader;
	private seq = 0;
	private stderrTail = "";
	private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	private lateError: ((message: string) => void) | null = null;

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
		const proc = spawn(OMP_BIN, args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// Inherit the environment: omp resolves credentials, config, and the
			// model catalog from it.
			env: process.env,
		});

		const { stdin, stdout, stderr } = proc;
		if (!stdin || !stdout || !stderr)
			throw new Error("omp child was spawned without stdio pipes");

		const child = new RpcChild((signal) => proc.kill(signal), stdin);
		stdout.on("data", (d: Buffer) => child.reader.push(d));
		(stderr as Readable).on("data", (d: Buffer) => {
			child.stderrTail = (child.stderrTail + d.toString("utf8")).slice(-STDERR_KEEP);
		});

		const ready = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`omp did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
			}, READY_TIMEOUT_MS);

			const off = child.onFrame((frame) => {
				if (frame.type !== "ready") return;
				clearTimeout(timer);
				off();
				resolve(frame);
			});

			proc.once("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(timer);
				reject(
					err.code === "ENOENT"
						? new Error(
								`cannot run "${OMP_BIN}": not found on PATH. Set PIW_OMP_BIN to its absolute path (a systemd user unit does not read your shell profile).`,
							)
						: err,
				);
			});

			proc.once("exit", (code, signal) => {
				clearTimeout(timer);
				reject(new Error(child.exitMessage(code, signal)));
			});
		});

		proc.once("exit", (code, signal) => child.onExit(code, signal));

		let readyFrame: Record<string, unknown>;
		try {
			readyFrame = await ready;
		} catch (err) {
			proc.kill("SIGKILL");
			throw err;
		}

		// Opt into lossless framing when the server offers it. Failing to
		// negotiate is not fatal — v1 still works — but it means large frames can
		// be truncated, so it is worth a line in the log.
		const versions = readyFrame.supportedProtocolVersions;
		if (Array.isArray(versions) && versions.includes(2)) {
			await child
				.send("negotiate_protocol", { protocolVersion: 2 })
				.catch((err: Error) =>
					console.error("[piw] protocol v2 negotiation failed:", err.message),
				);
		}

		return child;
	}

	onFrame(listener: (frame: Record<string, unknown>) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	/** Route late `prompt` failures, which have no pending request to reject. */
	setLateErrorHandler(handler: (message: string) => void): void {
		this.lateError = handler;
	}

	private dispatch(frame: Record<string, unknown>): void {
		if (frame.type === "response") {
			const id = typeof frame.id === "string" ? frame.id : undefined;
			const pending = id === undefined ? undefined : this.pending.get(id);

			if (id !== undefined && pending) {
				this.pending.delete(id);
				this.settled.add(id);
				if (frame.success === true) pending.resolve(frame.data);
				else
					pending.reject(new Error(String(frame.error ?? `${pending.command} failed`)));
				return;
			}

			if (frame.success !== true) {
				const message = String(frame.error ?? "omp reported a failure");
				// Unknown-command and parse failures arrive with id undefined.
				if (id !== undefined && this.settled.has(id)) this.lateError?.(message);
				else console.error(`[piw] omp ${String(frame.command)} failed:`, message);
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
			return Promise.reject(
				new Error(this.exitMessage(this.exited.code, this.exited.signal)),
			);
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
		return tail ? `omp exited (${how}):\n${tail}` : `omp exited (${how})`;
	}

	/**
	 * Closing stdin is omp's documented clean shutdown: it drains accepted
	 * commands, disposes the session, and exits 0. The timers are for the case
	 * where it does not — a wedged child must not outlive its session and hold
	 * a JSONL open.
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
export interface OmpSession {
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
	/** Slash commands this session accepts, kept current by omp's own pushes. */
	readonly commands: PiCommand[];
	/** The question omp is blocked on, or null if it is not waiting on one. */
	readonly ask: PiAsk | null;
	/** Children this session is running right now, newest omp reading. */
	readonly subagents: PiSubagent[];
	messages(): PiMessage[];
	prompt(text: string, images?: PiImage[]): Promise<void>;
	abort(): Promise<void>;
	/**
	 * Answer the pending question. False if `id` is not the one omp is
	 * actually waiting on — the caller's answer is then for a dialog that has
	 * already gone, and sending it would misattribute it to the next one.
	 */
	answerAsk(id: string, answer: AskAnswer): boolean;
	/** Switch models mid-session. Throws if the spec is malformed or unresolvable. */
	setModel(spec: string): Promise<void>;
	/**
	 * Set the reasoning effort. Throws on a level this model does not accept:
	 * omp answers `success` to any string and then reports NO level at all,
	 * so the check has to happen on this side of the boundary.
	 */
	setThinkingLevel(level: string): Promise<void>;
	/**
	 * Rename the session. omp owns the title: it writes the fixed-width line-1
	 * `title` entry in the JSONL, and marks the name as user-set so its own
	 * auto-titler stops overwriting it. Doing this by hand from piw would mean
	 * reimplementing that slot format against a file omp is still appending to.
	 */
	setName(name: string): Promise<void>;
	subscribe(listener: (e: PiEvent) => void): () => void;
	dispose(): void;
}

export interface OpenOptions {
	cwd: string;
	/** Existing session file to resume. Omit to create a new persisted session. */
	file?: string;
	/** "provider/id", e.g. "anthropic/claude-sonnet-4-5". Omit for omp's default. */
	model?: string;
}

/** A roster chip is one line wide. */
const SUBAGENT_LABEL_MAX = 70;

/**
 * One line saying what a child is doing.
 *
 * Its `description` is the live activity once omp has one and its written
 * assignment before that — and an assignment is a structured brief, whose
 * first line is the heading `# Target`. Headings are skipped for the first
 * line of actual prose, because "Target" describes no work at all.
 */
function subagentLabel(value: unknown): string {
	if (typeof value !== "string") return "";
	const line =
		value
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l && !l.startsWith("#")) ?? "";
	return line.length > SUBAGENT_LABEL_MAX ? `${line.slice(0, SUBAGENT_LABEL_MAX)}…` : line;
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
 * Open (or resume) a session.
 *
 * Sessions are ALWAYS persisted (never --no-session): persistence is the real
 * crash safety net that makes the error handling here an optimization rather
 * than load-bearing.
 */
export async function openSession(opts: OpenOptions): Promise<OmpSession> {
	/*
	 * A resumed session's cwd comes from its own header, not from the caller.
	 * The open route only knows a cwd when CREATING, so resuming a session that
	 * belongs to another project would otherwise launch the agent pointed at
	 * whichever project the client happened to have selected — and its tools
	 * would then read and write the wrong tree. The header is authoritative.
	 */
	let cwd = opts.cwd;
	if (opts.file) {
		// A missing path would send `-r` to omp's interactive picker, which in RPC
		// mode is a child that never becomes ready. Fail with the path instead.
		if (!existsSync(opts.file)) throw new Error(`session file not found: ${opts.file}`);
		cwd = (await sessionHeaderCwd(opts.file)) ?? opts.cwd;
	}

	const args = ["--mode", "rpc-ui", "--cwd", cwd, "--approval-mode", APPROVAL_MODE];
	if (opts.file) args.push("-r", opts.file);
	if (opts.model) args.push("--model", opts.model);

	const child = await RpcChild.start(args, cwd);

	const state = await fetchState(child);
	let messages = healDanglingToolCalls(await fetchMessages(child));
	/**
	 * Bumped on every appended message. A resync that started before an append
	 * must not overwrite the newer list — omp accepts a follow-up prompt the
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
	/*
	 * Fetched rather than waited for: omp pushes the catalog once at startup,
	 * and that push lands before this function has a frame handler installed.
	 * The push is still handled below, for the case where a plugin or an
	 * extension changes the set later.
	 */
	let commands = toCommands(await fetchCommands(child));

	/**
	 * The children this session is running.
	 *
	 * omp keeps the authoritative list (`get_subagents` returns only the live
	 * ones and drops each child the moment it settles), so the push frames are
	 * used as a TRIGGER to re-read it rather than merged by hand: the two frame
	 * shapes (`subagent_lifecycle` carries the record, `subagent_progress`
	 * carries a progress object around it) would otherwise be reassembled here,
	 * in a second place, against a bus that already does it.
	 *
	 * Subscription is opt-in per client and defaults to off, so without this
	 * call the frames never arrive at all.
	 */
	let subagents: PiSubagent[] = [];
	await child
		.send("set_subagent_subscription", { level: "progress" })
		.catch(() => {
			// An omp too old to know the method still runs sessions; the roster is
			// simply always empty.
		});

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

	child.setLateErrorHandler((message) => {
		streaming = false;
		emit({ type: "error", message });
	});

	/**
	 * Re-read everything the SESSION decides: which modalities the model takes,
	 * which reasoning levels it offers, how big its window is, and how much of
	 * that window is occupied. One cheap round trip that cannot drift, rather
	 * than trusting an event frame's own shape.
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
	 * Re-read the roster and tell the browser.
	 *
	 * Coalesced: at the `progress` subscription level a busy child pushes a
	 * frame per step, and a fan-out of eight would otherwise be eight RPC
	 * round trips and eight SSE writes for one visible row change.
	 */
	let rosterTimer: NodeJS.Timeout | undefined;
	const refreshSubagents = () => {
		clearTimeout(rosterTimer);
		rosterTimer = setTimeout(() => {
			void child
				.send<unknown>("get_subagents")
				.then((data) => {
					const list = isRecord(data) && Array.isArray(data.subagents) ? data.subagents : [];
					subagents = list.filter(isRecord).map((s) => ({
						id: String(s.id ?? ""),
						agent: String(s.agent ?? "task"),
						description: subagentLabel(s.description ?? s.assignment),
						status: String(s.status ?? "running"),
					}));
					emit({ type: "subagents", subagents });
				})
				.catch(() => {});
		}, SUBAGENT_SETTLE_MS).unref();
	};

	/**
	 * Re-read the whole history from omp.
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
				// get_messages is refused while streaming or compacting. The
				// accumulated list stands; the next settle tries again.
			});
	};

	/**
	 * A prompt that finished without an agent turn: a local slash command. No
	 * `agent_end` follows, so this is the only thing that would ever clear the
	 * spinner.
	 */
	const settleLocalPrompt = () => {
		streaming = false;
		emit({ type: "idle" });
	};

	/**
	 * Re-read the session after a local command changed it.
	 *
	 * `command_output` is the only evidence such a command had an effect: the
	 * prompt ack arrives BEFORE the work, measured against a real `/compact`
	 * (ack with `agentInvoked: false`, then "Compaction complete. Tokens:
	 * 22519 -> 18940" seconds later). So the ack cannot be the trigger — it
	 * would read the pre-compaction history back and change nothing.
	 *
	 * Coalesced, because a command may print several lines and re-reading a
	 * long session is megabytes per read.
	 */
	let settleTimer: NodeJS.Timeout | undefined;
	const resyncAfterCommand = () => {
		clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			// `idle` once the re-read has landed, because nothing else tells an
			// attached client that the transcript it is showing has changed. The
			// session is genuinely idle here: a local command runs no turn.
			void Promise.all([resyncMessages(), refreshState()]).then(() =>
				emit({ type: "idle" }),
			);
		}, COMMAND_SETTLE_MS).unref();
	};

	/**
	 * The question omp is currently blocked on, if any. One at a time by
	 * construction: the `ask` tool is `concurrency: "exclusive"` and the
	 * selector UI it drives is a single shared surface, so a second request
	 * replacing the first is omp moving to the next question, not two dialogs
	 * racing.
	 */
	let pendingAsk: PiAsk | null = null;
	let askTimer: NodeJS.Timeout | undefined;
	const clearAsk = () => {
		clearTimeout(askTimer);
		if (!pendingAsk) return;
		pendingAsk = null;
		emit({ type: "ask", ask: null });
	};

	const unsubscribe = child.onFrame((frame) => {
		switch (frame.type) {
			case "message_update": {
				const ev = frame.assistantMessageEvent;
				if (!isRecord(ev)) break;
				// Assembled from deltas rather than from `partial`: the docs tell
				// clients to accumulate, and `partial` carries the whole message so
				// far on every event, which is quadratic to forward.
				if (ev.type === "text_delta") {
					streaming = true;
					emit({ type: "text", delta: String(ev.delta ?? "") });
				} else if (ev.type === "thinking_delta") {
					streaming = true;
					emit({ type: "thinking", delta: String(ev.delta ?? "") });
				}
				break;
			}

			case "agent_start":
				streaming = true;
				break;

			case "tool_execution_start":
				emit({
					type: "tool_start",
					id: String(frame.toolCallId ?? ""),
					name: String(frame.toolName ?? ""),
					args: frame.args,
				});
				break;

			case "tool_execution_end":
				emit({
					type: "tool_end",
					id: String(frame.toolCallId ?? ""),
					name: String(frame.toolName ?? ""),
					isError: Boolean(frame.isError),
					result: textOf(isRecord(frame.result) ? frame.result.content : undefined),
				});
				break;

			case "message_end": {
				const m = frame.message;
				if (!isRecord(m)) break;
				messages = [...messages, m];
				generation++;
				if (isRecord(m.usage) && typeof m.usage.totalTokens === "number") {
					contextTokens = m.usage.totalTokens;
				}

				// IMPORTANT: a failed turn does NOT produce an error frame. omp
				// reports provider errors (401s, quota, overload) as an assistant
				// message with stopReason "error", empty content, and errorMessage
				// set. Without this branch the UI renders a blank message and never
				// learns anything went wrong — verified against a real 401.
				if (m.role === "assistant" && m.stopReason === "error") {
					const status =
						typeof m.errorStatus === "number" ? ` (HTTP ${m.errorStatus})` : "";
					streaming = false;
					emit({
						type: "error",
						message: `${String(m.errorMessage ?? "assistant turn failed")}${status}`,
					});
					break;
				}

				emit({ type: "message_done", message: toPiMessage(m) });
				break;
			}

			case "agent_end":
				/*
				 * NOT `messages = frame.messages`. That field carries only the
				 * messages of the turn that just ended, so assigning it truncates
				 * the transcript to the last exchange — found by prompting twice and
				 * watching a five-message session report two. The accumulated
				 * message_end list is the history; this only schedules a correction.
				 */
				void resyncMessages();
				// A turn can end with children still running (that is the whole
				// point of background delegation), and it can end BECAUSE the last
				// one finished. Either way the roster on screen is now stale.
				refreshSubagents();
				// isTerminal false means maintenance or async delivery has already
				// scheduled more work, so the session is NOT idle yet. Treating it as
				// idle clears the partial and drops the spinner mid-run.
				if (frame.isTerminal !== false) {
					streaming = false;
					emit({ type: "idle" });
				}
				break;

			case "auto_compaction_end":
				// Compaction rewrites history into a summary. The event stream only
				// ever appends, so a resync is the only way the transcript learns
				// that older messages are gone — and the freed context only shows
				// up in the session's own accounting.
				void resyncMessages();
				void refreshState();
				break;

			case "model_changed":
				void refreshState();
				break;

			case "available_commands_update":
				// Plugins and extensions can add or remove commands mid-session, and
				// omp pushes the whole list when they do.
				commands = toCommands(frame.commands);
				break;

			/*
			 * The answer to a local slash command: "Compaction complete. Tokens:
			 * 22519 -> 18940", `/cost`, `/tree`. It is the ONLY output such a
			 * command produces — no message is appended to the session — so
			 * dropping this frame is what makes a command look like it never ran.
			 */
			case "command_output": {
				const text = String(frame.text ?? "").trim();
				if (text) emit({ type: "notice", notice: { level: "info", text } });
				// `/compact` and `/clear` rewrite history; `/model` and `/thinking`
				// change the session. Which one this was is not worth parsing out of
				// the text — re-read the session and let it say.
				resyncAfterCommand();
				break;
			}

			/*
			 * Maintenance talking: "snapcompact would not reduce context",
			 * "Auto-compaction failed: ...". Not turn failures, so not the error
			 * banner, but the user is owed the reason their context did not move.
			 */
			case "notice": {
				const text = String(frame.message ?? "").trim();
				if (!text) break;
				const source = typeof frame.source === "string" ? frame.source : "";
				emit({
					type: "notice",
					notice: {
						level:
							frame.level === "error"
								? "error"
								: frame.level === "warning"
									? "warning"
									: "info",
						text: source ? `${source}: ${text}` : text,
					},
				});
				break;
			}

			case "prompt_result":
				if (frame.agentInvoked === false) settleLocalPrompt();
				break;

			/*
			 * A child started, finished, or moved. Both frames are a trigger to
			 * re-read the roster rather than a record to merge — see
			 * `refreshSubagents`. `agent_end` also refreshes, because a turn that
			 * ends with children still registered is the state this roster exists
			 * to make visible.
			 */
			case "subagent_lifecycle":
			case "subagent_progress":
				refreshSubagents();
				break;

			/*
			 * A blocking request is a question for the USER, not something to
			 * answer on their behalf. It is held until the browser answers it;
			 * `cancel` is omp withdrawing one it no longer needs.
			 */
			case "extension_ui_request": {
				if (frame.method === "cancel") {
					clearAsk();
					break;
				}
				const ask = toAsk(frame);
				if (!ask) break;
				pendingAsk = ask;
				clearTimeout(askTimer);
				/*
				 * omp resolves a timed dialog to its default on its own, and says
				 * nothing when it does. Without this the panel would sit there
				 * asking for an answer omp has stopped listening for.
				 */
				const timeout = typeof frame.timeout === "number" ? frame.timeout : 0;
				if (timeout > 0) askTimer = setTimeout(clearAsk, timeout).unref();
				emit({ type: "ask", ask });
				break;
			}

			case "extension_error":
				console.error(
					`[piw] omp extension error in ${String(frame.extensionPath)} (${String(frame.event)}):`,
					frame.error,
				);
				break;
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
		get subagents() {
			return subagents;
		},
		get ask() {
			return pendingAsk;
		},
		messages() {
			return stitch(messages.map(toPiMessage));
		},
		async prompt(text: string, images?: PiImage[]) {
			// Convert BEFORE sending: a bad attachment should surface as a rejected
			// prompt, not as a half-started turn that fails mid-flight.
			const attachments = images?.length ? images.map(toImageContent) : undefined;

			// streamingBehavior is REQUIRED while streaming or the command fails.
			const data = await child.send<unknown>("prompt", {
				message: text,
				...(attachments ? { images: attachments } : {}),
				...(streaming ? { streamingBehavior: "followUp" } : {}),
			});

			// The ack is acceptance, not completion. Only a local-only prompt is
			// finished here, and it is the one case nothing else will report.
			if (isRecord(data) && data.agentInvoked === false) {
				streaming = false;
				emit({ type: "idle" });
			} else {
				streaming = true;
			}
		},
		answerAsk(id: string, answer: AskAnswer) {
			/*
			 * The id is checked, not trusted. A stale one is routine — omp times a
			 * dialog out, or withdraws it, while the click is in flight — and
			 * posting it anyway would answer whatever question omp asked NEXT with
			 * the answer to the one before it.
			 */
			if (!pendingAsk || pendingAsk.id !== id) return false;
			child.post({ type: "extension_ui_response", id, ...answer });
			clearAsk();
			return true;
		},
		async abort() {
			/*
			 * omp cancels a dialog its own abort path interrupts, but says nothing
			 * about it, so the answer has to go first: the extension is waiting on
			 * a response, and abandoning the panel would leave the browser showing
			 * a question for a turn that is over.
			 */
			if (pendingAsk) {
				child.post({ type: "extension_ui_response", id: pendingAsk.id, cancelled: true });
				clearAsk();
			}
			await child.send("abort");
		},
		async setModel(spec: string) {
			const slash = spec.indexOf("/");
			if (slash <= 0) throw new Error(`model must be "provider/id", got: ${spec}`);
			await child.send("set_model", {
				provider: spec.slice(0, slash),
				modelId: spec.slice(slash + 1),
			});
			const next = await fetchState(child);
			model = next.model;
			supportsImages = next.supportsImages;
			// The new model brings its own reasoning levels, its own window, and its
			// own count of the same conversation.
			thinkingLevel = next.thinkingLevel;
			thinkingLevels = next.thinkingLevels;
			contextWindow = next.contextWindow;
			contextTokens = next.contextTokens;
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
			// omp rejects an empty name, and the error it returns says nothing
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
			clearTimeout(settleTimer);
			clearTimeout(askTimer);
			child.close();
		},
	};
}

/**
 * `get_state` carries the resolved model object, including its accepted input
 * modalities — so image support comes from the session itself rather than from
 * a separate catalog lookup that could disagree with it.
 */
async function fetchState(child: RpcChild): Promise<SessionState> {
	const data = await child.send<unknown>("get_state");
	if (!isRecord(data)) throw new Error("omp returned no session state");
	const m = isRecord(data.model) ? data.model : undefined;
	const provider = m && typeof m.provider === "string" ? m.provider : undefined;
	const id = m && typeof m.id === "string" ? m.id : undefined;

	/*
	 * `model.thinking.efforts` is the model's own list — opus offers
	 * low..max, haiku offers minimal..xhigh — and "off" is accepted by every
	 * model that has the block at all. A model with no `thinking` gets an
	 * empty list, which is how the UI knows not to offer the control.
	 */
	const thinking = isRecord(m?.thinking) ? m.thinking : undefined;
	const efforts = Array.isArray(thinking?.efforts)
		? thinking.efforts.filter((e): e is string => typeof e === "string")
		: [];

	/*
	 * `contextUsage` is omp's live occupancy for this session, and the only
	 * number that follows a compaction down: the newest assistant `usage`
	 * still describes the prefix that was just folded away (measured: 21417
	 * reported here against a stale 23276 on the message).
	 */
	const usage = isRecord(data.contextUsage) ? data.contextUsage : undefined;

	return {
		sessionId: String(data.sessionId ?? ""),
		sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : undefined,
		model: provider && id ? `${provider}/${id}` : undefined,
		// Absent metadata is treated as "no": offering an attach button that 400s
		// is worse than not offering one.
		supportsImages: Array.isArray(m?.input) && m.input.includes("image"),
		isStreaming: data.isStreaming === true,
		thinkingLevel:
			typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined,
		thinkingLevels: efforts.length > 0 ? ["off", ...efforts] : [],
		contextWindow: typeof m?.contextWindow === "number" ? m.contextWindow : 0,
		contextTokens: typeof usage?.tokens === "number" ? usage.tokens : 0,
	};
}

async function fetchMessages(child: RpcChild): Promise<OmpMessage[]> {
	const data = await child.send<unknown>("get_messages");
	return isRecord(data) ? records(data.messages) : [];
}

async function fetchCommands(child: RpcChild): Promise<unknown> {
	const data = await child.send<unknown>("get_available_commands");
	return isRecord(data) ? data.commands : [];
}

/**
 * omp's UI requests, split into the two kinds this host can honour.
 *
 * These are not optional to handle. Two `setWidget` frames arrive before this
 * host sends a single command, and a blocking method (`confirm`, `input`,
 * `select`, `editor`) left unanswered stalls the extension that asked — which
 * from the browser is indistinguishable from a hung agent.
 *
 * Display-only methods are dropped: this UI has no status line or widget rail
 * to render them in. The blocking four become a `PiAsk` and are put to the
 * USER, which is what they were for: the `ask` tool is a question addressed
 * to a person, and cancelling it (the old behavior here) failed the tool call
 * and lost the question with it.
 *
 * `optionDetails` is positional — omp emits it only when some option has a
 * description — so it is read by index and every field is treated as absent
 * until proven otherwise.
 */
export function toAsk(frame: Record<string, unknown>): PiAsk | null {
	const id = frame.id;
	if (typeof id !== "string") return null;

	const title = typeof frame.title === "string" ? frame.title : undefined;
	const message = typeof frame.message === "string" ? frame.message : undefined;

	switch (frame.method) {
		case "select": {
			const details = records(frame.optionDetails);
			const options = (Array.isArray(frame.options) ? frame.options : [])
				.map((o, i) => ({
					label: String(o),
					description:
						typeof details[i]?.description === "string"
							? String(details[i].description)
							: undefined,
				}))
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
				value: typeof frame.value === "string" ? frame.value : undefined,
				multiline: frame.method === "editor",
			};
		// notify / setStatus / setWidget / setTitle / set_editor_text / cancel /
		// open_url expect no response.
		default:
			return null;
	}
}
