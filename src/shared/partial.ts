import type { PiEvent, PiPartial } from "./types.js";

export const emptyPartial = (): PiPartial => ({ text: "", thinking: "", tools: [] });

/** The same immutable accumulation for server snapshots and browser streaming state. */
export function reducePartial(partial: PiPartial, event: PiEvent): PiPartial {
	switch (event.type) {
		case "text": return { ...partial, text: partial.text + event.delta };
		case "thinking": return { ...partial, thinking: partial.thinking + event.delta };
		case "tool_start": return { ...partial, tools: [...partial.tools, {
			id: event.id, name: event.name, args: event.args,
			...(event.source ? { source: event.source } : {}),
			...(event.parentId ? { parentId: event.parentId, startedAt: event.at, running: true } : {}),
		}] };
		case "tool_update": return { ...partial, tools: partial.tools.map((tool) =>
			tool.id === event.id ? { ...tool, result: event.result } : tool) };
		case "tool_end": return { ...partial, tools: partial.tools.map((tool) =>
			tool.id === event.id ? {
				...tool, result: event.result, isError: event.isError,
				...(event.source ? { source: event.source } : {}),
				...(event.at !== undefined && tool.startedAt !== undefined ? { durationMs: Math.max(0, event.at - tool.startedAt) } : {}),
				...(tool.running !== undefined ? { running: false } : {}),
			} : tool) };
		case "message_done":
		case "idle": return emptyPartial();
		default: return partial;
	}
}
