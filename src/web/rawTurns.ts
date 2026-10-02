import type { PiBlock, PiMessage, PiPartial } from "../shared/types.js";
import type { TurnActivity } from "../shared/activity.js";

export type RawRow = {
	role: PiMessage["role"];
	at: number;
	answerAt?: number;
	blocks: PiBlock[];
	work?: PiBlock[];
	running?: boolean;
	workStartedAt?: number;
	workEndedAt?: number;
	activity?: TurnActivity;
};

/** Keep only a settled final answer outside the work disclosure. */
function partitionTurn(messages: PiMessage[], live: boolean): { work: PiMessage[]; answer?: PiMessage } {
	const last = messages.at(-1);
	if (live || !last || last.role !== "assistant" || last.blocks.some((b) => b.kind === "tool")) return { work: messages };
	let cut = last.blocks.length;
	while (cut > 0 && ["text", "image"].includes(last.blocks[cut - 1].kind)) cut--;
	if (cut === last.blocks.length) return { work: messages };
	return {
		work: [...messages.slice(0, -1), ...(cut ? [{ ...last, blocks: last.blocks.slice(0, cut) }] : [])],
		answer: { ...last, blocks: last.blocks.slice(cut) },
	};
}

/** One disclosure per assistant turn, with only its settled final answer outside. */
export function rawRows(messages: PiMessage[], partial: PiPartial, busy: boolean, activity: TurnActivity[] = []): RawRow[] {
	const rows: RawRow[] = [];
	let turn: PiMessage[] = [];
	let turnAt: number | undefined;
	const flush = (live: boolean) => {
		if (!turn.length && !live) return;
		const { work, answer } = partitionTurn(turn, live);
		const blocks = work.flatMap((message) => message.blocks);
		if (live) blocks.push(
			...(partial.thinking ? [{ kind: "thinking" as const, text: partial.thinking }] : []),
			...(partial.text ? [{ kind: "text" as const, text: partial.text }] : []),
			...partial.tools.map((tool) => ({ kind: "tool" as const, ...tool })),
		);
		const at = turnAt ?? turn[0]?.timestamp ?? 0;
		const trace = activity.find((item) => item.asked === at);
		rows.push({
			role: "assistant", at, answerAt: answer?.timestamp, blocks: answer?.blocks ?? [], work: blocks, running: live, activity: trace,
			workStartedAt: trace?.start ?? turnAt ?? turn[0]?.timestamp,
			// Never use the next prompt or the current clock as a historical end time.
			workEndedAt: live ? undefined : trace?.end ?? turn.at(-1)?.endedAt,
		});
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
