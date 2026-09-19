/**
 * drafts.ts — what has been typed but not sent yet.
 *
 * The composer used to live only in React state, so a reload cost you it: the
 * dev server restarting, a stray refresh, or the page being reloaded mid-run
 * threw away the text AND every staged screenshot. Both now survive, and
 * survive a browser restart, which is the same promise the restored tab strip
 * already makes.
 *
 * Keyed by SESSION, so switching tabs swaps composers instead of carrying one
 * half-written message between conversations. The key is the session id, which
 * pi reports from `get_state` as soon as the child is up and is therefore the
 * same id after a reload — unlike the file, which appears only once a new
 * session is prompted and would move the draft out from under a composer
 * being typed into.
 *
 * Text and images are two entries on purpose. The text is rewritten on every
 * keystroke and a pasted screenshot is megabytes of base64: one entry would
 * re-serialise the images for every character typed.
 */

import type { PiImage } from "../shared/types.js";

const TEXT_PREFIX = "piw:draft:";
const IMAGES_PREFIX = "piw:draft-images:";

/**
 * Drafts kept at once, newest first. Sessions are never deleted from this
 * browser's point of view, so nothing else would ever reclaim the megabytes a
 * staged screenshot costs in a conversation nobody returns to.
 */
const MAX_DRAFTS = 16;

export interface Draft {
	text: string;
	images: PiImage[];
}

function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		// Private mode / disabled storage must not break the app.
		return null;
	}
}

function removeStored(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {
		/* ignore */
	}
}

/** Storage is user-writable and outlives any rename, so every read validates. */
function parse<T>(raw: string | null, shape: (value: unknown) => T | undefined): T | undefined {
	if (!raw) return undefined;
	try {
		return shape(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/** `{ text, at }` — `at` is what makes the oldest draft identifiable for pruning. */
function asText(value: unknown): { text: string; at: number } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { text, at } = value as { text?: unknown; at?: unknown };
	if (typeof text !== "string") return undefined;
	return { text, at: typeof at === "number" ? at : 0 };
}

function asImages(value: unknown): PiImage[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const images: PiImage[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const { data, mimeType } = item as { data?: unknown; mimeType?: unknown };
		if (typeof data === "string" && typeof mimeType === "string") images.push({ data, mimeType });
	}
	return images;
}

export function readDraft(key: string): Draft {
	return {
		text: parse(readStored(TEXT_PREFIX + key), asText)?.text ?? "",
		images: parse(readStored(IMAGES_PREFIX + key), asImages) ?? [],
	};
}

export function writeDraftText(key: string, text: string): void {
	// An empty composer with nothing attached is not a draft; leaving the entry
	// behind would keep a dead key alive and count against MAX_DRAFTS.
	if (!text && !readStored(IMAGES_PREFIX + key)) {
		removeStored(TEXT_PREFIX + key);
		return;
	}
	prune(key);
	write(TEXT_PREFIX + key, JSON.stringify({ text, at: Date.now() }));
}

/**
 * Persist the staged attachments. Returns false when they do not fit: base64
 * screenshots are the one thing here big enough to exhaust the ~5MB quota, and
 * the caller can then say so rather than silently promising a draft it did not
 * keep. The images stay staged in memory either way.
 */
export function writeDraftImages(key: string, images: PiImage[]): boolean {
	if (images.length === 0) {
		removeStored(IMAGES_PREFIX + key);
		return true;
	}

	prune(key);
	// Keep `at` current: an image was just staged, so this draft is the newest
	// one whatever the text last did.
	const existing = parse(readStored(TEXT_PREFIX + key), asText);
	write(TEXT_PREFIX + key, JSON.stringify({ text: existing?.text ?? "", at: Date.now() }));

	const payload = JSON.stringify(images);
	if (write(IMAGES_PREFIX + key, payload)) return true;

	// Out of quota. Every other session's images are worth less than the ones
	// being staged right now, so drop them and try once more.
	for (const other of draftKeys()) {
		if (other !== key) removeStored(IMAGES_PREFIX + other);
	}
	if (write(IMAGES_PREFIX + key, payload)) return true;

	// Still too big on its own. Do not leave a truncated or stale entry behind
	// to be restored in place of what is actually attached.
	removeStored(IMAGES_PREFIX + key);
	return false;
}

export function clearDraft(key: string): void {
	removeStored(TEXT_PREFIX + key);
	removeStored(IMAGES_PREFIX + key);
}

function write(key: string, value: string): boolean {
	try {
		localStorage.setItem(key, value);
		return true;
	} catch {
		// Quota, or storage disabled entirely. Distinguishing them buys nothing:
		// both mean this draft is memory-only.
		return false;
	}
}

/** Session keys with a draft of either kind. */
function draftKeys(): string[] {
	const keys = new Set<string>();
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k?.startsWith(TEXT_PREFIX)) keys.add(k.slice(TEXT_PREFIX.length));
			else if (k?.startsWith(IMAGES_PREFIX)) keys.add(k.slice(IMAGES_PREFIX.length));
		}
	} catch {
		/* ignore */
	}
	return [...keys];
}

/** Drop the oldest drafts until writing `keep` leaves at most MAX_DRAFTS. */
function prune(keep: string): void {
	const others = draftKeys().filter((k) => k !== keep);
	if (others.length < MAX_DRAFTS) return;

	const byAge = others
		.map((k) => ({ k, at: parse(readStored(TEXT_PREFIX + k), asText)?.at ?? 0 }))
		.sort((a, b) => a.at - b.at);
	for (const { k } of byAge.slice(0, others.length - MAX_DRAFTS + 1)) clearDraft(k);
}
