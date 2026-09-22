/**
 * sessions.ts — the session list, read straight off pi's on-disk store.
 *
 * pi persists one JSONL file per conversation under
 * `~/.pi/agent/sessions/<encoded-cwd>/<ISO-timestamp>_<uuid>.jsonl`, and we
 * parse those files ourselves rather than asking the CLI. Two reasons:
 *
 * 1. `pi --mode rpc` is one subprocess per *open* session. Listing is a
 *    whole-store question, so routing it through a subprocess would mean
 *    spawning one just to enumerate — ~1s of startup per poll.
 * 2. The directory name is NOT a usable key. The cwd encoding is lossy
 *    (`/tmp/pi-probe` → `--tmp-pi-probe--`; every separator becomes the same
 *    character the path may already contain), so reimplementing it would be a
 *    guess that silently returns an empty list. Every session file carries its
 *    own `{"type":"session","version":3,"id":…,"cwd":…}` header entry, which is
 *    authoritative. We therefore scan all project directories and filter on it.
 *
 * The entry types pi writes are: `session`, `session_info`, `model_change`,
 * `thinking_level_change`, `compaction` and `message`. Only `message` is a
 * conversation turn (`message.role` is `user` | `assistant` | `toolResult`);
 * everything else is metadata.
 */

import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { PiSessionInfo } from "../shared/types.js";

/** Enough to fill the one-line preview in the list; the rest is dead weight. */
const FIRST_MESSAGE_MAX = 200;

/**
 * Concurrent open files. A busy project reaches hundreds of sessions and this
 * runs on every poll, so an unbounded `Promise.all` would open hundreds of
 * descriptors at once — fast until it hits EMFILE, then broken for everything
 * else in the process.
 */
const CONCURRENCY = 8;

/** Everything one poll needs from a session file, plus its cache stamp. */
interface Parsed {
	size: number;
	mtimeMs: number;
	birthtimeMs: number;
	id?: string;
	cwd?: string;
	/** `session.timestamp`, already ISO in the file. */
	created?: string;
	/**
	 * The timestamp of the LAST `message` entry.
	 *
	 * Not the file's mtime and not the last line: pi appends `session_info`,
	 * `thinking_level_change` and `model_change` rows for things that are not
	 * conversation — including on a bare resume, which is why merely opening a
	 * session would otherwise shove it to the top of an mtime-ordered list
	 * with its message count unchanged.
	 */
	lastMessage?: string;
	/** The session's display name, from the last `session_info` entry. */
	title?: string;
	firstMessage: string;
	messageCount: number;
}

/**
 * The whole reason this module is not a naive readFile loop.
 *
 * Sessions reach several MB (tool output dominates), the list is polled every
 * few seconds, and `messageCount` needs every line — so a cold read is a full
 * pass and must happen at most once per version of the file. `size` +
 * `mtimeMs` is the version: pi only ever appends to a session file, so a
 * change is always a longer file or a newer mtime, never a rewrite in place.
 */
const cache = new Map<string, Parsed>();

/** List persisted sessions for a workspace, newest created first. */
export async function listSessions(cwd: string): Promise<PiSessionInfo[]> {
	// Read per call, not captured at import: the tests point PWI_SESSION_ROOT at
	// a temp dir, and a module-level constant would bake in whatever the env
	// held when this module first loaded.
	const root = process.env.PWI_SESSION_ROOT ?? join(homedir(), ".pi", "agent", "sessions");
	// Symlink resolution is memoized per call, never across calls: a cwd that
	// gets moved or a symlink that is retargeted must not be answered from a
	// cache that nothing invalidates.
	const canon = new Map<string, string>();
	const want = await canonical(cwd, canon);

	let dirs: string[];
	try {
		dirs = (await readdir(root, { withFileTypes: true }))
			.filter((d) => d.isDirectory() || d.isSymbolicLink())
			.map((d) => d.name);
	} catch {
		// No store yet (fresh machine) is an empty list, not an error.
		return [];
	}

	// Each directory returns its own list rather than pushing into a shared
	// array from concurrent callbacks; the flat() at the end is the only place
	// they meet.
	const perDir = await Promise.all(
		dirs.map(async (dir) => {
			try {
				const names = await readdir(join(root, dir));
				return names.filter((n) => n.endsWith(".jsonl")).map((n) => join(root, dir, n));
			} catch {
				// Deleted between the two readdirs: a session file or a whole
				// project directory can vanish under us, so losing this race is
				// routine, not a failure.
				return [];
			}
		}),
	);
	const files = perDir.flat();

	const out: PiSessionInfo[] = [];
	await pooled(files, async (file) => {
		const parsed = await readParsed(file);
		// No `cwd` header means we cannot attribute the file to a project. It
		// belongs to no list rather than to every list.
		if (!parsed?.cwd) return;
		if ((await canonical(parsed.cwd, canon)) !== want) return;
		out.push(project(file, parsed));
	});

	/*
	 * Newest created first, which is the order the client's default sort wants
	 * and a stable one for the other mode to re-sort. Created is the session's
	 * own header timestamp, so it never moves — unlike mtime, which every
	 * resume bumps.
	 */
	return out.sort((a, b) => b.created.localeCompare(a.created));
}

/**
 * The cwd a session file was recorded against, or undefined if the file is
 * unreadable or predates the header.
 *
 * Callers use this to decide whether an arbitrary path belongs to the open
 * project, so it reads the memo first and otherwise stops at the header
 * instead of counting the whole file. The header-only result is intentionally
 * not written to the memo: it has no message count, and caching it would make
 * the next `listSessions` report zero messages for this session.
 */
export async function sessionHeaderCwd(file: string): Promise<string | undefined> {
	const abs = resolve(file);
	let st: Stats;
	try {
		st = await stat(abs);
	} catch {
		cache.delete(abs);
		return undefined;
	}
	const hit = cache.get(abs);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.cwd;
	return (await parse(abs, st, true))?.cwd;
}

/**
 * When the last message in the FILE was written, as epoch ms.
 *
 * For asking "has anyone else appended to this session?". Timestamps are the
 * one quantity both sides of that question agree on: the raw entry count
 * cannot be compared against a rendered transcript, because a `message` entry
 * is not a rendered row (tool results fold into their call, and compaction
 * replaces many entries with one).
 *
 * Undefined when the file is unreadable or holds no timestamped message —
 * both meaning "no basis to claim it is ahead".
 */
export async function lastMessageAt(file: string): Promise<number | undefined> {
	const ts = (await readParsed(resolve(file)))?.lastMessage;
	if (!ts) return undefined;
	const ms = Date.parse(ts);
	return Number.isNaN(ms) ? undefined : ms;
}

async function readParsed(file: string): Promise<Parsed | undefined> {
	let st: Stats;
	try {
		st = await stat(file);
	} catch {
		cache.delete(file);
		return undefined;
	}
	const hit = cache.get(file);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
	const parsed = await parse(file, st, false);
	// A failed read is not cached, so the next poll retries rather than
	// remembering a truncated count forever.
	if (parsed) cache.set(file, parsed);
	return parsed;
}

/**
 * Stream one session file. `headerOnly` stops at the `session` entry.
 *
 * Line-at-a-time via readline, never readFile: the point is to avoid holding a
 * multi-MB string (and its JSON garbage) for every session on every poll.
 */
async function parse(
	file: string,
	st: Stats,
	headerOnly: boolean,
): Promise<Parsed | undefined> {
	const out: Parsed = {
		size: st.size,
		mtimeMs: st.mtimeMs,
		birthtimeMs: st.birthtimeMs,
		firstMessage: "",
		messageCount: 0,
	};
	const stream = createReadStream(file, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			if (!line) continue;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				// pi appends live, so the final line of an active session is
				// regularly half-written. Skipping is the correct reading of a
				// torn line; throwing would blank the whole list mid-turn.
				continue;
			}
			if (!entry || typeof entry !== "object") continue;
			switch (entry.type) {
				case "session":
					if (typeof entry.id === "string") out.id = entry.id;
					if (typeof entry.cwd === "string") out.cwd = entry.cwd;
					if (typeof entry.timestamp === "string") out.created = entry.timestamp;
					if (headerOnly) return out;
					break;
				case "session_info":
					// Appended on every rename, so the LAST one is the live name.
					if (typeof entry.name === "string" && entry.name) out.title = entry.name;
					break;
				case "message": {
					// Every `message` entry counts, `toolResult` rows included.
					// The badge is a "how big is this session" signal, not a
					// rendered-row count — it cannot be the latter anyway, since
					// the chat panel folds tool results into their originating
					// tool call.
					out.messageCount++;
					if (!out.firstMessage) out.firstMessage = userText(entry.message);
					// Last one wins: the entries are in file order, so this ends
					// up as the newest real conversation activity.
					if (typeof entry.timestamp === "string") out.lastMessage = entry.timestamp;
					break;
				}
				default:
					break;
			}
		}
	} catch {
		// Vanished or unreadable mid-stream. Report nothing rather than a
		// partial count that would be cached as if complete.
		return undefined;
	} finally {
		rl.close();
		stream.destroy();
	}
	return out;
}

/**
 * The preview text of a user turn, or "" for anything else.
 *
 * pi stores user content as a block array; a pasted screenshot makes the first
 * block an `image`, so we look for the first `text` block rather than assuming
 * index 0.
 */
function userText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "user" || !Array.isArray(m.content)) return "";
	for (const block of m.content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: unknown; text?: unknown };
		if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
			return b.text.trim().slice(0, FIRST_MESSAGE_MAX);
		}
	}
	return "";
}

function project(file: string, p: Parsed): PiSessionInfo {
	const info: PiSessionInfo = {
		// The filename embeds the same uuid as the header, so it is a real
		// fallback rather than a synthetic id: a session whose header line was
		// lost still resolves to the id its file is named after.
		id: p.id ?? idFromFilename(file),
		path: file,
		created: iso(p.created, p.birthtimeMs || p.mtimeMs),
		// mtime is deliberately NOT reported. It answers "when was this file
		// last written", which a bare resume satisfies, and the list has no use
		// for a timestamp that moves without the conversation. The fallback
		// below is for a session whose messages predate timestamped entries.
		lastActive: iso(p.lastMessage, p.mtimeMs),
		messageCount: p.messageCount,
		firstMessage: p.firstMessage,
	};
	// Left unset when the session has never been named, because the UI falls
	// back to `firstMessage` only for a falsy name.
	if (p.title) info.name = p.title;
	return info;
}

/** `2026-09-14T19-18-17-693Z_01a0a15b-...jsonl` → `01a0a15b-...`. */
function idFromFilename(file: string): string {
	const stem = basename(file).replace(/\.jsonl$/, "");
	const underscore = stem.indexOf("_");
	return underscore >= 0 ? stem.slice(underscore + 1) : stem;
}

function iso(recorded: string | undefined, fallbackMs: number): string {
	if (recorded) {
		const t = Date.parse(recorded);
		if (!Number.isNaN(t)) return new Date(t).toISOString();
	}
	return new Date(fallbackMs).toISOString();
}

/**
 * Compare paths by their real location so `/home/loki/x` and a symlinked
 * equivalent land in the same list. realpath fails on a deleted directory —
 * which is exactly the case of "sessions for a project I just removed" — so
 * that falls back to the resolved string instead of throwing.
 */
async function canonical(path: string, memo: Map<string, string>): Promise<string> {
	const abs = resolve(path);
	const hit = memo.get(abs);
	if (hit !== undefined) return hit;
	let value: string;
	try {
		value = await realpath(abs);
	} catch {
		value = abs;
	}
	memo.set(abs, value);
	return value;
}

/**
 * Whether two paths name the same project. Same comparison listSessions uses,
 * exported because the open route has to answer "does this session file belong
 * to the project the client asked for?" — and a session recorded through a
 * symlinked cwd must not read as a different project.
 */
export async function sameProject(a: string, b: string): Promise<boolean> {
	const memo = new Map<string, string>();
	return (await canonical(a, memo)) === (await canonical(b, memo));
}

/** Run `fn` over `items` with at most CONCURRENCY in flight. */
async function pooled<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) await fn(items[next++] as T);
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}
