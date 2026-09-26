/**
 * Which sessions want the user, and how urgently.
 *
 * One state per session, shown the same way in the tab π, the session list,
 * the window title and the favicon:
 *  - `needs`: blocked on a question only the user can answer.
 *  - `ready`: finished something since this browser last had it on screen.
 *  - `working`: streaming.
 */

import type { PiSessionInfo } from "../shared/types.js";
import type { SeenSessions } from "./prefs.js";

export type Attention = "needs" | "ready" | "working" | null;

export function attentionOf(s: PiSessionInfo, seen: SeenSessions): Attention {
	if (s.needsInput) return "needs";
	if (s.isStreaming) return "working";
	const last = Date.parse(s.lastActive);
	const saw = Date.parse(seen.seen[s.path] ?? seen.baseline);
	return last > saw ? "ready" : null;
}

/** How each state looks, shared by the tab π and the session-list dot. */
export const ATTENTION_UI = {
	needs: { text: "text-red-400", dot: "bg-red-400", label: "needs your answer" },
	ready: { text: "text-neutral-500", dot: "bg-amber-400", label: "new reply" },
	working: { text: "animate-pulse text-amber-400", dot: "animate-pulse bg-amber-400", label: "working" },
} as const;

/** Sort rank: what to look at first. */
export function attentionRank(a: Attention): number {
	return a === "needs" ? 0 : a === "ready" ? 1 : 2;
}

/** The window title: waiting count, then `●` while anything works. */
export function attentionTitle(states: Attention[]): string {
	const waiting = states.filter((a) => a === "needs" || a === "ready").length;
	const working = states.includes("working");
	return `${waiting ? `${waiting} ` : ""}${working ? "\u25cf " : ""}pwi`;
}

/**
 * The session Alt+J should jump to: questions before replies, the one
 * waiting longest first, and never the one already on screen.
 */
export function nextWaiting(
	sessions: PiSessionInfo[],
	states: Map<string, Attention>,
	current: string | undefined,
): string | undefined {
	return sessions
		.filter((s) => s.path !== current && attentionRank(states.get(s.path) ?? null) < 2)
		.sort(
			(a, b) =>
				attentionRank(states.get(a.path) ?? null) - attentionRank(states.get(b.path) ?? null) ||
				Date.parse(a.lastActive) - Date.parse(b.lastActive),
		)[0]?.path;
}
