/**
 * sessions.ts — the session list, read straight off omp's on-disk store.
 *
 * omp persists one JSONL file per conversation under
 * `~/.omp/agent/sessions/<encoded-cwd>/<ISO-timestamp>_<uuid>.jsonl`, and we
 * parse those files ourselves rather than asking the CLI. Two reasons:
 *
 * 1. `omp --mode rpc-ui` is one subprocess per *open* session. Listing is a
 *    whole-store question, so routing it through a subprocess would mean
 *    spawning one just to enumerate — ~1s of Node startup per poll.
 * 2. The directory name is NOT a usable key. The cwd encoding is inconsistent
 *    (`/tmp/omprpc-x` → `-tmp-omprpc-x`, but `/mnt/c/Users/loki` →
 *    `--mnt-c-Users-loki--`), so reimplementing it would be a guess that
 *    silently returns an empty list. Every session file carries its own
 *    `{"type":"session",...,"cwd":"..."}` header entry, which is authoritative.
 *    We therefore scan all project directories and filter on that field.
 *
 * The entry types omp writes are: `session`, `title`, `title_change`,
 * `model_change`, `thinking_level_change`, `credential_pin`, `ttsr_injection`,
 * `custom`, `custom_message`, and `message`. Only `message` is a conversation
 * turn (`message.role` is `user` | `assistant` | `toolResult`); everything else
 * is metadata or tool-execution telemetry.
 */

import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
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
	 * Not the file's mtime and not the last line: omp appends `custom`,
	 * `thinking_level_change` and `title` rows for things that are not
	 * conversation — including on a bare resume, which is why merely opening a
	 * session used to shove it to the top of an mtime-ordered list with its
	 * message count unchanged.
	 */
	lastMessage?: string;
	title?: string;
	firstMessage: string;
	messageCount: number;
}

/**
 * The whole reason this module is not a naive readFile loop.
 *
 * Sessions reach several MB (tool output dominates), the list is polled every
 * few seconds, and `messageCount` needs every line — so a cold read is a full
 * pass and must happen at most once per version of the file. `size` + `mtimeMs`
 * is the version: omp only ever appends to the transcript, and the one entry it
 * rewrites in place (the line-1 `title`, which is why that entry carries a
 * `pad` field) still bumps mtime.
 *
 * We deliberately do NOT resume from a stored byte offset on append. It would
 * be faster still, but a title that outgrows its padding forces omp to rewrite
 * the file with a different line-1 length, shifting every later offset — and a
 * desynced resume reads JSON from the middle of a line, which fails as silent
 * corruption rather than an error. A full pass per change is cheap and cannot
 * be wrong.
 */
const cache = new Map<string, Parsed>();

/** List persisted sessions for a workspace, newest created first. */
export async function listSessions(cwd: string): Promise<PiSessionInfo[]> {
	// Read per call, not captured at import: the tests point PIW_SESSION_ROOT at
	// a temp dir, and a module-level constant would bake in whatever the env
	// held when this module first loaded.
	const root =
		process.env.PIW_SESSION_ROOT ?? join(homedir(), ".omp", "agent", "sessions");
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

	const files: string[] = [];
	await Promise.all(
		dirs.map(async (dir) => {
			try {
				for (const name of await readdir(join(root, dir))) {
					if (name.endsWith(".jsonl")) files.push(join(root, dir, name));
				}
			} catch {
				// Deleted between the two readdirs. omp reaps old project
				// directories, so losing a race here is routine, not a failure.
			}
		}),
	);

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
 * The session's CURRENT title, read from line 1 only.
 *
 * omp keeps the live title in a fixed-width line-1 `title` entry and rewrites
 * it in place, so one line is the whole answer — and this is polled while
 * waiting for omp's titler to produce a name, which is why it opens 8 KiB
 * rather than streaming a multi-megabyte transcript. Empty string covers
 * every "no title": unreadable file, torn line, a session omp has not titled.
 */
export async function sessionTitle(file: string): Promise<string> {
	try {
		const handle = await open(resolve(file));
		try {
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
			const text = buffer.toString("utf8", 0, bytesRead);
			const newline = text.indexOf("\n");
			// No newline in 8 KiB means line 1 is not the title slot omp writes;
			// parsing a prefix of some other entry would be worse than nothing.
			if (newline < 0) return "";
			const entry = JSON.parse(text.slice(0, newline)) as {
				type?: unknown;
				title?: unknown;
			};
			if (entry?.type !== "title" || typeof entry.title !== "string") return "";
			return entry.title;
		} finally {
			await handle.close();
		}
	} catch {
		return "";
	}
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
				// omp appends live, so the final line of an active session is
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
					// The header also carries a `title`, but only as it stood
					// when the session was created; the line-1 `title` entry is
					// the one omp keeps current. Only take it as a fallback.
					if (!out.title && typeof entry.title === "string" && entry.title) {
						out.title = entry.title;
					}
					if (headerOnly) return out;
					break;
				case "title":
					// Rewritten in place on every rename, so this is the live
					// title regardless of the `title_change` history below it.
					if (typeof entry.title === "string" && entry.title) out.title = entry.title;
					break;
				case "message": {
					// Every `message` entry counts, `toolResult` rows included,
					// and `custom_message` never does. The badge is a "how big is
					// this session" signal, not a rendered-row count — it cannot
					// be the latter anyway, since the chat panel folds tool
					// results into their originating tool call. Counting exactly
					// what pi's SessionManager.list counted keeps the number
					// stable across the migration instead of introducing a second
					// notion of session size.
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
 * omp stores user content as a block array; a pasted screenshot makes the first
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
		// last written", which a resume or a title rewrite satisfies, and the
		// list has no use for a timestamp that moves without the conversation.
		// The fallback below is for a session whose messages predate timestamped
		// entries; it is the closest thing the file still knows.
		lastActive: iso(p.lastMessage, p.mtimeMs),
		messageCount: p.messageCount,
		firstMessage: p.firstMessage,
	};
	// Left unset when omp has no title yet (it writes an empty one immediately),
	// because the UI falls back to `firstMessage` only for a falsy name.
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
