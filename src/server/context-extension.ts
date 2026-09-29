/**
 * context-extension.ts — a pi extension, not server code.
 *
 * agent.ts loads it into every session child for the context popup. The
 * command `/pwi-context` measures what the context is made of and hands it
 * back as a `setStatus` frame keyed by the command name: pi's RPC has no
 * command for this, and a command's status is the only output that reaches
 * the host before pi acks the prompt.
 *
 * Sizes are pi's own estimate (chars / 4, an image as 4800 chars). The system
 * prompt is split along the `<section>` tags pi wraps each part in; a forced
 * prompt has none and counts as system prompt whole.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
// With `.ts`: pi's loader, not tsx, resolves these.
import { contentChars, program, splitBySteps, subKey } from "../shared/toolCalls.ts";
import { parseMetrics, type Step } from "../tool-metrics/format.ts";

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = {
	role: string;
	content?: string | Block[];
	toolName?: string;
	toolCallId?: string;
	summary?: string;
	command?: string;
	output?: string;
};

/** The minimum of pi's ExtensionAPI this file uses; pi is not a dependency here. */
interface Pi {
	getActiveTools(): string[];
	getAllTools(): { name: string; description?: string; parameters?: unknown }[];
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (
				args: string,
				ctx: {
					getSystemPrompt(): string;
					sessionManager: { buildSessionProjection(): { messages: Message[] }; getSessionId(): string };
					ui: { setStatus(key: string, text: string | undefined): void };
				},
			) => Promise<void>;
		},
	): void;
}

interface Item {
	name: string;
	tokens: number;
	count?: number;
	items?: Item[];
}

const COMMAND = "pwi-context";
const tokens = (chars: number) => Math.ceil(chars / 4);

/** `<name>…</name>` in the prompt, "" when absent. */
function section(prompt: string, name: string): string {
	const start = prompt.indexOf(`<${name}>\n`);
	if (start < 0) return "";
	const close = `\n</${name}>`;
	const end = prompt.indexOf(close, start);
	return end < 0 ? "" : prompt.slice(start, end + close.length);
}

/** One item per `open…close` block, named by `name`'s first group. */
function blocks(text: string, block: RegExp, name: RegExp): Item[] {
	const home = process.env.HOME;
	return [...text.matchAll(block)].map((m) => ({
		name: (name.exec(m[0])?.[1] ?? "?").replace(home && home !== "/" ? home : "\0", "~"),
		tokens: tokens(m[0].length),
	}));
}

type Tally = { name: string; tokens: number; count: number; subs: Map<string, Tally> };

function bump(into: Map<string, Tally>, name: string, chars: number, count: number): Tally {
	const k = into.get(name) ?? { name, tokens: 0, count: 0, subs: new Map() };
	k.tokens += chars;
	k.count += count;
	into.set(name, k);
	return k;
}

function items(tallies: Map<string, Tally>): Item[] {
	return [...tallies.values()]
		.map(({ name, tokens: chars, count, subs }) => ({
			name,
			tokens: tokens(chars),
			count,
			...(subs.size > 0 && { items: items(subs) }),
		}))
		.filter((k) => k.tokens > 0)
		.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Conversation chars by kind, and tool calls plus their results by tool, and
 * within a tool by program or file (toolCalls.ts).
 */
function conversation(messages: Message[], measured: Map<string, Step[]>): Item[] {
	const kinds = new Map<string, Tally>();
	const home = process.env.HOME;
	/** A call's sub-item, for its result to land in. */
	const subs = new Map<string, string>();
	/** A measured bash call's own chars, split over its commands once its result is in. */
	const split = new Map<string, number>();
	const add = (name: string, chars: number, count = 0, sub?: string) => {
		const k = bump(kinds, name, chars, count);
		if (sub !== undefined) bump(k.subs, sub, chars, count);
	};
	for (const m of messages) {
		if (m.role === "user") add("Your messages", contentChars(m.content), 1);
		else if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.type === "text") add("Replies", b.text?.length ?? 0);
				else if (b.type === "thinking") add("Thinking", b.thinking?.length ?? 0);
				else if (b.type === "toolCall" && b.id && measured.has(b.id)) {
					const chars = (b.name?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length;
					split.set(b.id, chars);
					add(`tool:${b.name}`, chars, 1);
				} else if (b.type === "toolCall") {
					let sub = subKey(b.name ?? "", b.arguments);
					if (sub && home && home !== "/" && sub.startsWith(home)) sub = `~${sub.slice(home.length)}`;
					if (sub !== undefined && b.id) subs.set(b.id, sub);
					add(`tool:${b.name}`, (b.name?.length ?? 0) + JSON.stringify(b.arguments ?? {}).length, 1, sub);
				}
			}
		} else if (m.role === "toolResult" && split.has(m.toolCallId ?? "")) {
			const id = m.toolCallId ?? "";
			const chars = contentChars(m.content);
			const k = bump(kinds, `tool:${m.toolName ?? "?"}`, chars, 0);
			const steps = measured.get(id) ?? [];
			const shares = splitBySteps((split.get(id) ?? 0) + chars, steps);
			steps.forEach((s, i) => bump(k.subs, program(s.text), shares[i] ?? 0, s.runs ?? 1));
			split.delete(id);
		} else if (m.role === "toolResult")
			add(`tool:${m.toolName ?? "?"}`, contentChars(m.content), 0, subs.get(m.toolCallId ?? ""));
		else if (m.role === "compactionSummary" || m.role === "branchSummary")
			add("Summaries", m.summary?.length ?? 0, 1);
		else if (m.role === "bashExecution") add("Shell commands", (m.command?.length ?? 0) + (m.output?.length ?? 0), 1);
		else add("Other", contentChars(m.content));
	}
	return items(kinds);
}

/** This session's bash calls the tool-metrics collector split into commands, by call id. */
function measuredSteps(sessionId: string): Map<string, Step[]> {
	const out = new Map<string, Step[]>();
	const dir = process.env.PWI_TOOL_METRICS_DIR;
	if (!dir || !/^[\w-]+$/.test(sessionId)) return out;
	try {
		for (const r of parseMetrics(readFileSync(join(dir, `${sessionId}.jsonl`), "utf8")))
			if (!r.type && r.steps?.length) out.set(r.toolCallId, r.steps);
	} catch {
		// None measured yet.
	}
	return out;
}

export default function context(pi: Pi) {
	pi.registerCommand(COMMAND, {
		description: "pwi internal: measure the context",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			const rules = section(prompt, "project_context");
			const skills = section(prompt, "skills");
			const personality = section(prompt, "addendum");
			const active = new Set(pi.getActiveTools());
			const tools = pi
				.getAllTools()
				.filter((t) => active.has(t.name))
				.map((t) => ({
					name: t.name,
					tokens: tokens(
						JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length,
					),
				}))
				.sort((a, b) => b.tokens - a.tokens);
			const parts = [
				{ key: "system", tokens: tokens(prompt.length - rules.length - skills.length - personality.length) },
				{ key: "tools", tokens: tools.reduce((n, t) => n + t.tokens, 0), items: tools },
				{
					key: "rules",
					tokens: tokens(rules.length),
					items: blocks(rules, /<project_instructions path="[^"]*">[\s\S]*?<\/project_instructions>/g, /path="([^"]*)"/),
				},
				{
					key: "skills",
					tokens: tokens(skills.length),
					items: blocks(skills, /<skill>[\s\S]*?<\/skill>/g, /<name>([^<]*)<\/name>/).sort(
						(a, b) => b.tokens - a.tokens,
					),
				},
				{ key: "personality", tokens: tokens(personality.length) },
			];
			const convo = conversation(
				ctx.sessionManager.buildSessionProjection().messages,
				measuredSteps(ctx.sessionManager.getSessionId()),
			);
			parts.push({ key: "conversation", tokens: convo.reduce((n, c) => n + c.tokens, 0), items: convo });
			ctx.ui.setStatus(COMMAND, JSON.stringify(parts));
			ctx.ui.setStatus(COMMAND, undefined);
		},
	});
}
