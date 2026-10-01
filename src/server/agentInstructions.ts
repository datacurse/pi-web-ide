import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "./packages.js";

export async function readAgentFile(path: string) {
	try {
		return { path, content: await readFile(path, "utf8"), error: null };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { path, content: null, error: null };
		}
		return { path, content: null, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function agentInstructions(cwd: string) {
	const [global, local] = await Promise.all([
		readAgentFile(join(agentDir(), "AGENTS.md")),
		readAgentFile(join(cwd, "AGENTS.md")),
	]);
	return { global, local };
}
