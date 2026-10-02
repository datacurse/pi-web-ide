import type { PiBlock, PiMessage, PiPartial, PiTool } from "../shared/types.js";
import { partitionPhaseTurn } from "./turnPhases.js";
import { sessionTodos, type TodoTask } from "../shared/todos.js";

export type RawRow = {
	role: PiMessage["role"];
	at: number;
	blocks: PiBlock[];
	work?: PiBlock[];
	todos?: TodoTask[];
	running?: boolean;
};

/** One disclosure per assistant turn, with only its settled final answer outside. */
export function rawRows(messages: PiMessage[], partial: PiPartial, busy: boolean): RawRow[] {
	const rows: RawRow[] = [];
	const history: PiMessage[] = [];
	const hasTodo = (tool: PiTool): boolean => tool.name === "todo" || (tool.children ?? []).some(hasTodo);
	let turn: PiMessage[] = [];
	let turnAt: number | undefined;
	const flush = (live: boolean) => {
		if (!turn.length && !live) return;
		const { work, answer } = partitionPhaseTurn(turn, live);
		const blocks = work.flatMap((message) => message.blocks);
		if (live) blocks.push(
			...(partial.thinking ? [{ kind: "thinking" as const, text: partial.thinking }] : []),
			...(partial.text ? [{ kind: "text" as const, text: partial.text }] : []),
			...partial.tools.map((tool) => ({ kind: "tool" as const, ...tool })),
		);
		const turnTools = turn.flatMap((message) => message.blocks.filter((block) => block.kind === "tool"));
		const hasTodos = turnTools.some(hasTodo) || (live && partial.tools.some(hasTodo));
		history.push(...turn);
		const todos = hasTodos ? sessionTodos(history, live ? partial : { text: "", thinking: "", tools: [] }) : [];
		rows.push({ role: "assistant", at: turnAt ?? turn[0]?.timestamp ?? 0, blocks: answer?.blocks ?? [], work: blocks, running: live, todos });
		turn = [];
	};
	for (const message of messages) {
		if (message.role === "assistant" || message.role === "toolResult") turn.push(message);
		else {
			flush(false);
			rows.push({ role: message.role, at: message.timestamp, blocks: message.blocks });
			turnAt = message.timestamp;
		}
	}
	flush(busy || !!partial.text || !!partial.thinking || partial.tools.length > 0);
	return rows;
}
