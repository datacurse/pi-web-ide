/**
 * remind-extension.ts — a pi extension, not server code.
 *
 * agent.ts loads it into a session child with `-e` when "Repeat before every
 * reply" is on. It re-sends the personality text at the end of every user
 * message before each model request, because text at the top of the system
 * prompt loses weight as a session grows and the model drifts toward the style
 * of its own recent replies.
 *
 * `context` changes only the request. pi restores the messages afterwards, so
 * the reminder is never saved to the session file or shown in the transcript.
 *
 * Every user message carries it, not only the latest, so earlier messages are
 * byte-identical from one request to the next. That keeps the prompt cache
 * hitting and keeps earlier thinking blocks valid; on Opus 5.5 an edit to an
 * earlier turn can fail the request with a 400.
 *
 * For the same reason the file is read once, on the first request, and that
 * text is used for the rest of the session. An edit reaches new sessions only.
 * An empty or missing file sends nothing.
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

/** Messages with `text` appended to every user message. Exported for the test. */
export function withReminder(messages: Message[], text: string): Message[] {
	if (!text) return messages;
	const extra: Part = { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
	return messages.map((m) =>
		m.role !== "user"
			? m
			: {
					...m,
					content:
						typeof m.content === "string"
							? [{ type: "text", text: m.content }, extra]
							: [...(m.content ?? []), extra],
				},
	);
}

export default function remind(pi: Pi) {
	pi.registerFlag("pwi-remind", { type: "string", description: "File to repeat before every reply" });
	let text: string | undefined; // snapshot for this session; see the header
	pi.on("context", async (event) => {
		const path = pi.getFlag("pwi-remind");
		if (typeof path !== "string") return undefined;
		if (text === undefined) {
			try {
				text = readFileSync(path, "utf8").trim();
			} catch {
				text = ""; // Deleted since spawn: nothing to repeat.
			}
		}
		return { messages: withReminder(event.messages, text) };
	});
}
