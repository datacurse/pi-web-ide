import type { PiBlock, PiMessage, PiPartial } from "../shared/types.js";
import { partitionPhaseTurn } from "./turnPhases.js";

export type RawRow = {
	role: PiMessage["role"];
	at: number;
	blocks: PiBlock[];
	work?: PiBlock[];
	running?: boolean;
};

/** One disclosure per assistant turn, with only its settled final answer outside. */
export function rawRows(messages: PiMessage[], partial: PiPartial, busy: boolean): RawRow[] {
	const rows: RawRow[] = [];
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
		rows.push({ role: "assistant", at: turnAt ?? turn[0]?.timestamp ?? 0, blocks: answer?.blocks ?? [], work: blocks, running: live });
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
