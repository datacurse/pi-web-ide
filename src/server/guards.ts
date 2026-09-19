/**
 * guards.ts — the canonical runtime narrowing helpers for wire data.
 *
 * Server-side only, and deliberately not in shared/types.ts: that module is
 * types with zero imports precisely so the browser bundle can never pull
 * server code in behind a value import.
 *
 * These narrow *shape*, not contract. They prove "this is an object" and
 * "these are the object entries of an array"; every field read afterwards
 * still checks its own type. That split is intentional — the RPC frames and
 * session JSONL these are used on are versioned by another program, so a field
 * that changes type must degrade to "skipped", never to a throw in the middle
 * of a live transcript.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * The object entries of an unknown array, with non-objects dropped.
 *
 * Used wherever the wire hands us a content/message list: a malformed entry
 * should cost that entry, not the whole message.
 */
export function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}
