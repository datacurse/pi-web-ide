import type { PiBlock, PiTool } from "../shared/types.js";
import type { TurnActivity } from "../shared/activity.js";

export type ThoughtItem = { kind: "thought"; block: Extract<PiBlock, { kind: "thinking" }>; durationMs?: number; active: boolean };
export type WorkItem =
	| { kind: "prose"; blocks: PiBlock[] }
	| ThoughtItem
	| { kind: "tools"; blocks: Extract<PiBlock, { kind: "tool" }>[]; entries: (ThoughtItem | Extract<PiBlock, { kind: "tool" }>)[]; active: boolean };

const argsOf = (tool: PiTool): Record<string, unknown> =>
	tool.args && typeof tool.args === "object" ? tool.args as Record<string, unknown> : {};

export function toolCategory(tool: PiTool): "file" | "search" | "other" {
	if (["read", "read_symbol", "read_enclosing", "module_report"].includes(tool.name)) return "file";
	if (["grep", "find", "ls", "anchor_grep", "symbol_search", "ast_grep_search", "project_report"].includes(tool.name)) return "search";
	if (tool.name === "bash" && /^(rg|grep|find|ls)\b/.test(String(argsOf(tool).command ?? "").trim())) return "search";
	return "other";
}

/** Count leaves, not the codemode wrapper as well as its children. */
export function toolLeaves(tools: PiTool[]): PiTool[] {
	return tools.flatMap((tool) => tool.children?.length ? toolLeaves(tool.children) : [tool]);
}

export function explorationLabel(tools: PiTool[], active: boolean): string {
	const leaves = toolLeaves(tools);
	const files = leaves.filter((tool) => toolCategory(tool) === "file").length;
	const searches = leaves.filter((tool) => toolCategory(tool) === "search").length;
	const others = leaves.length - files - searches;
	const counts = [
		files ? `${files} ${files === 1 ? "file" : "files"}` : "",
		searches ? `${searches} ${searches === 1 ? "search" : "searches"}` : "",
		others ? `${others} ${others === 1 ? "tool" : "tools"}` : "",
	].filter(Boolean).join(", ");
	const verbs = files || searches ? ["Explored", "Exploring"] : ["Ran", "Running"];
	const verb = verbs[active ? 1 : 0];
	const failed = leaves.filter((tool) => tool.isError).length;
	const interrupted = leaves.filter((tool) => tool.interrupted).length;
	const outcomes = [failed ? `${failed} failed` : "", interrupted ? `${interrupted} interrupted` : ""].filter(Boolean);
	return [`${verb} ${counts}`, ...outcomes].join(" · ");
}

export function toolDescription(tool: PiTool): string {
	const args = argsOf(tool);
	const category = toolCategory(tool);
	const target = typeof args.path === "string" ? args.path : "";
	if (category === "file") {
		const start = typeof args.offset === "number" ? args.offset : undefined;
		const end = start !== undefined && typeof args.limit === "number" ? `–${start + args.limit - 1}` : "";
		const range = start === undefined ? "" : ` L${start}${end}`;
		return `Read ${target || tool.name}${range}`;
	}
	if (category === "search") return `Searched ${String(args.pattern ?? args.query ?? args.command ?? (target || tool.name))}`;
	if (tool.name === "bash") return `Ran ${String(args.command ?? "command")}`;
	return tool.name;
}

/** Preserve prose order; fold adjacent tools and intervening thoughts into one exploration. */
export function workTimeline(blocks: PiBlock[], activity: TurnActivity | undefined, running: boolean): WorkItem[] {
	const items: WorkItem[] = [];
	const phases = activity?.steps.filter((step) => step.kind === "thinking") ?? [];
	const thinkingCount = blocks.filter((block) => block.kind === "thinking").length;
	let thoughtIndex = 0;
	for (const block of blocks) {
		if (block.kind === "thinking") {
			// Old/unobserved traces, or mismatched phase counts, must not invent a duration.
			const phase = phases.length === thinkingCount ? phases[thoughtIndex] : undefined;
			thoughtIndex++;
			const active = running && block === blocks.at(-1) && (activity ? activity.steps.at(-1)?.kind === "thinking" : true);
			const thought: ThoughtItem = { kind: "thought", block, active, durationMs: phase?.end === undefined ? undefined : phase.end - phase.start };
			const previous = items.at(-1);
			if (previous?.kind === "tools") previous.entries.push(thought);
			else items.push(thought);
		} else if (block.kind === "tool") {
			const previous = items.at(-1);
			if (previous?.kind === "tools") { previous.blocks.push(block); previous.entries.push(block); }
			else items.push({ kind: "tools", blocks: [block], entries: [block], active: false });
		} else {
			const previous = items.at(-1);
			if (previous?.kind === "prose") previous.blocks.push(block);
			else items.push({ kind: "prose", blocks: [block] });
		}
	}
	for (const item of items) {
		if (item.kind !== "tools") continue;
		const tools = [...item.blocks, ...toolLeaves(item.blocks)];
		const executing = tools.some((tool) => tool.running === true);
		// Legacy tool blocks may omit running flags; use the current tools phase,
		// never merely the fact that this is the last group in an unfinished turn.
		const legacyToolsPhase = tools.every((tool) => tool.running === undefined)
			&& activity?.steps.at(-1)?.kind === "tools" && item === items.at(-1);
		item.active = running && (executing || legacyToolsPhase);
	}
	return items;
}

export function currentWorkStatus(activity: TurnActivity | undefined, blocks: PiBlock[]): string | undefined {
	const phase = activity?.steps.at(-1)?.kind;
	if (phase === "thinking") return "Thinking";
	if (phase === "tools") return blocks.some((block) => block.kind === "tool") ? undefined : "Running tools";
	if (phase === "text") return undefined;
	if (phase === "retry") return "Waiting to retry";
	if (phase === "input") return "Waiting for your input";
	if (phase === "compaction") return "Compacting conversation";
	if (!activity) {
		if (toolLeaves(blocks.filter((block) => block.kind === "tool")).some((tool) => tool.running)) return undefined;
		if (blocks.at(-1)?.kind === "thinking") return "Thinking";
		if (blocks.at(-1)?.kind === "text") return undefined;
	}
	return "Planning next moves";
}
