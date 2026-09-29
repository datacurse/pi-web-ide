import { test } from "node:test";
import assert from "node:assert/strict";
import type { PiMessage } from "../shared/types.js";
import { chatMarkdown } from "./chatExport.js";

const messages: PiMessage[] = [
	{ role: "user", timestamp: 1, blocks: [{ kind: "text", text: "Why?" }] },
	{
		role: "assistant",
		timestamp: 2,
		blocks: [
			{ kind: "thinking", text: "Look first.\nThen answer." },
			{ kind: "tool", id: "1", name: "bash", args: { command: "ls" }, result: "a ``` b" },
		],
	},
	{ role: "assistant", timestamp: 3, blocks: [{ kind: "text", text: "Because." }] },
];

test("chat level keeps only questions and answers, one heading per speaker", () => {
	assert.equal(chatMarkdown(messages, "chat"), "## You\n\nWhy?\n\n## pi\n\nBecause.\n");
});

test("reasoning level quotes the thinking", () => {
	assert.equal(
		chatMarkdown(messages, "reasoning"),
		"## You\n\nWhy?\n\n## pi\n\n> Look first.\n> Then answer.\n\nBecause.\n",
	);
});

test("tools level adds calls and results, fenced past any backticks inside", () => {
	const md = chatMarkdown(messages, "tools");
	assert.match(md, /\*\*bash\*\*\n\n```json\n\{\n {2}"command": "ls"\n\}\n```/);
	assert.match(md, /````\na ``` b\n````/);
});
