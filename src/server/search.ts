/**
 * search.ts — full-text search over one project's sessions.
 *
 * Indexes what was said and done: user and assistant text plus tool-call
 * arguments (commands, edits, written files). Thinking and tool output are
 * left out; they are the bulk of a file and mostly noise in a snippet.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { PiSessionHit } from "../shared/types.js";
import { listSessions, pooled } from "./sessions.js";

const MAX_RESULTS = 50;
const SNIPPET_BEFORE = 24;
const SNIPPET_LENGTH = 160;

/** Searchable text per file (as written, and lowercased to match on), keyed by the same size+mtime version as sessions.ts. */
type Text = { raw: string; lower: string };
const cache = new Map<string, { size: number; mtimeMs: number } & Text>();

export async function searchSessions(cwd: string, query: string): Promise<PiSessionHit[]> {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!terms.length) return [];
	const sessions = await listSessions(cwd);
	const hits: (PiSessionHit & { rank: number })[] = [];
	await pooled(sessions, async (session) => {
		const text = await readText(session.path);
		const title = (session.name || session.firstMessage).toLowerCase();
		const inTitle = terms.every((t) => title.includes(t));
		const inAll = inTitle || terms.every((t) => title.includes(t) || text.lower.includes(t));
		// Fuzzy only on the title, where a subsequence still means something:
		// over megabytes of transcript nearly every query would match.
		const rank = inTitle ? 0 : inAll ? 1 : fuzzy(title, terms.join("")) ? 2 : -1;
		if (rank < 0) return;
		hits.push({ session, snippet: snippet(text, terms), rank });
	});
	return hits
		.sort((a, b) => a.rank - b.rank || b.session.lastActive.localeCompare(a.session.lastActive))
		.slice(0, MAX_RESULTS)
		.map(({ session, snippet }) => ({ session, snippet }));
}

/** Every character of `needle` in order in `hay`. Three characters minimum, or everything matches. */
function fuzzy(hay: string, needle: string): boolean {
	if (needle.length < 3) return false;
	let i = 0;
	for (const c of hay) if (c === needle[i] && ++i === needle.length) return true;
	return false;
}

/** A single line around the first term found, starting a little before it. */
function snippet(text: Text, terms: string[]): string {
	for (const t of terms) {
		const at = text.lower.indexOf(t);
		if (at < 0) continue;
		const start = Math.max(0, at - SNIPPET_BEFORE);
		const cut = text.raw.slice(start, at + SNIPPET_LENGTH).replace(/\s+/g, " ").trim();
		return start > 0 ? `…${cut}` : cut;
	}
	return "";
}

async function readText(file: string): Promise<Text> {
	let st;
	try {
		st = await stat(file);
	} catch {
		cache.delete(file);
		return { raw: "", lower: "" };
	}
	const hit = cache.get(file);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit;
	const parts: string[] = [];
	const stream = createReadStream(file, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			// Cheap pre-filter: most lines are not messages, and parsing a
			// multi-MB image line just to skip it is the expensive part.
			if (!line.includes('"type":"message"')) continue;
			let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const m = entry.message;
			if (entry.type !== "message" || (m?.role !== "user" && m?.role !== "assistant")) continue;
			if (typeof m.content === "string") parts.push(m.content);
			else if (Array.isArray(m.content))
				for (const b of m.content as { type?: unknown; text?: unknown; arguments?: unknown }[]) {
					if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
					else if (b?.type === "toolCall" && b.arguments && typeof b.arguments === "object")
						for (const v of Object.values(b.arguments)) if (typeof v === "string") parts.push(v);
				}
		}
	} catch {
		// Vanished mid-read: answer from what was read, but do not cache it.
		const raw = parts.join("\n");
		return { raw, lower: raw.toLowerCase() };
	} finally {
		rl.close();
		stream.destroy();
	}
	const raw = parts.join("\n");
	const text = { raw, lower: raw.toLowerCase() };
	cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, ...text });
	return text;
}
