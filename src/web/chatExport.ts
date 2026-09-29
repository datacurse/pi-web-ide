import type { PiMessage } from "../shared/types.js";

/** How much of a session the chat's right-click Copy takes. Each level adds to the one before. */
export type ChatExport = "chat" | "reasoning" | "tools";

/** A code fence longer than any backtick run inside, so the block cannot close early. */
function fenced(text: string, lang = ""): string {
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${lang}\n${text}\n${fence}`;
}

/**
 * The transcript as Markdown: a `## You` / `## pi` heading whenever the speaker
 * changes, then each message's parts. Images, compaction summaries and other
 * non-conversation messages are left out.
 */
export function chatMarkdown(messages: PiMessage[], level: ChatExport): string {
	const out: string[] = [];
	let speaker: string | null = null;
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const parts: string[] = [];
		for (const b of m.blocks) {
			if (b.kind === "text" && b.text.trim()) parts.push(b.text.trim());
			else if (b.kind === "thinking" && level !== "chat" && b.text.trim())
				parts.push(b.text.trim().replace(/^/gm, "> "));
			else if (b.kind === "tool" && level === "tools") {
				const args = typeof b.args === "string" ? b.args : JSON.stringify(b.args, null, 2);
				parts.push(`**${b.name}**${b.isError ? " (error)" : ""}\n\n${fenced(args ?? "", "json")}`);
				if (b.result) parts.push(fenced(b.result));
			}
		}
		if (parts.length === 0) continue;
		const who = m.role === "user" ? "You" : "pi";
		if (who !== speaker) out.push(`## ${who}`);
		speaker = who;
		out.push(...parts);
	}
	return out.join("\n\n") + "\n";
}
