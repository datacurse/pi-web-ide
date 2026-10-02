import type { PiMessage, PiPartial, PiTool } from "./types.js";

export interface TodoTask {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	activeForm?: string;
}

/** Read the extension's full snapshot, not its localized terminal output. */
export function todoTasks(name: unknown, details: unknown): TodoTask[] | undefined {
	if (name !== "todo" || !details || typeof details !== "object") return undefined;
	const tasks = (details as { tasks?: unknown }).tasks;
	if (!Array.isArray(tasks)) return undefined;
	if (!tasks.every((task) => task && typeof task === "object" &&
		Number.isInteger(task.id) && task.id > 0 && typeof task.subject === "string" &&
		["pending", "in_progress", "completed", "deleted"].includes(task.status))) return undefined;
	return tasks.map(({ id, subject, status, activeForm }) => ({
		id, subject, status, ...(typeof activeForm === "string" ? { activeForm } : {}),
	}));
}

/**
 * Saved codemode children omit result details. Replay only successful mutations
 * there; live calls and ordinary saved todo results carry authoritative snapshots.
 */
export function sessionTodos(messages: PiMessage[], partial: PiPartial): TodoTask[] {
	let tasks: TodoTask[] = [];
	let nextId = 1;
	const visit = (tool: PiTool) => {
		if (tool.name === "todo" && !tool.isError && !tool.interrupted) {
			if (tool.todos !== undefined) {
				tasks = tool.todos;
				nextId = Math.max(nextId, ...tasks.map((task) => task.id + 1));
				if (!tasks.length) nextId = 1;
			} else if (tool.outputUnavailable && !tool.running && tool.args && typeof tool.args === "object") {
				const args = tool.args as Record<string, unknown>;
				switch (args.action) {
					case "create":
						if (typeof args.subject === "string") tasks = [...tasks, { id: nextId++, subject: args.subject, status: "pending" }];
						break;
					case "update":
						tasks = tasks.map((task) => task.id === args.id ? {
							...task,
							...(typeof args.subject === "string" ? { subject: args.subject } : {}),
							...(["pending", "in_progress", "completed", "deleted"].includes(String(args.status)) ? { status: args.status as TodoTask["status"] } : {}),
							...(typeof args.activeForm === "string" ? { activeForm: args.activeForm } : {}),
						} : task);
						break;
					case "delete":
						tasks = tasks.map((task) => task.id === args.id ? { ...task, status: "deleted" } : task);
						break;
					case "clear":
						tasks = [];
						nextId = 1;
				}
			}
		}
		for (const child of tool.children ?? []) visit(child);
	};
	for (const message of messages) for (const block of message.blocks) if (block.kind === "tool") visit(block);
	for (const tool of partial.tools) visit(tool);
	return tasks.filter((task) => task.status !== "deleted");
}
