/**
 * remind-extension.ts — a pi extension, not server code.
 *
 * agent.ts loads it into a session child with `-e` when "Repeat before every
 * reply" is on. It re-sends the personality text at the end of the latest user
 * message before each model request, because text at the top of the system
 * prompt loses weight as a session grows and the model drifts toward the style
 * of its own recent replies.
 *
 * `context` changes only the request. pi restores the messages afterwards, so
 * the reminder is never saved to the session file or shown in the transcript.
 *
 * The file is read on every request, so an edit to the personality text
 * reaches the reminder in running sessions too, not only the system prompt of
 * new ones. An empty file sends nothing.
 *
 * ponytail: only the latest user message carries the reminder, so the previous
 * one changes back each turn and the prompt cache misses from there. Tag every
 * user message instead if cache cost matters more than tokens.
 */

import { readFileSync } from "node:fs";

type Part = { type: string; text?: string };
type Message = { role: string; content?: string | Part[] };

/** The minimum of pi's ExtensionAPI this file uses; pi is not a dependency here. */
interface Pi {
	registerFlag(name: string, options: { type: "string"; description?: string }): void;
	getFlag(name: string): boolean | string | undefined;
	on(
		event: "context",
		handler: (event: { messages: Message[] }) => Promise<{ messages: Message[] } | undefined>,
	): void;
}

/** Messages with `text` appended to the latest user message. Exported for the test. */
export function withReminder(messages: Message[], text: string): Message[] {
	const i = messages.findLastIndex((m) => m.role === "user");
	if (i < 0 || !text) return messages;
	const m = messages[i]!;
	const extra: Part = { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
	const content =
		typeof m.content === "string"
			? [{ type: "text", text: m.content }, extra]
			: [...(m.content ?? []), extra];
	return messages.with(i, { ...m, content });
}

export default function remind(pi: Pi) {
	pi.registerFlag("pwi-remind", { type: "string", description: "File to repeat before every reply" });
	pi.on("context", async (event) => {
		const path = pi.getFlag("pwi-remind");
		if (typeof path !== "string") return undefined;
		let text = "";
		try {
			text = readFileSync(path, "utf8").trim();
		} catch {
			// Deleted since spawn: nothing to repeat.
		}
		return { messages: withReminder(event.messages, text) };
	});
}
