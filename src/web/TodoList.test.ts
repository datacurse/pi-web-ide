import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TodoList } from "./TodoList.js";

test("todo list hides when empty and shows counts, states and active labels", () => {
	assert.equal(renderToStaticMarkup(createElement(TodoList, { tasks: [] })), "");
	const html = renderToStaticMarkup(createElement(TodoList, { tasks: [
		{ id: 1, subject: "Read code", status: "completed" },
		{ id: 2, subject: "Implement", status: "in_progress", activeForm: "Implementing checklist" },
		{ id: 3, subject: "Verify <script>", status: "pending" },
	] }));
	assert.match(html, /Todos.*\(1\/3\)/);
	assert.match(html, /line-through/);
	assert.match(html, /Implementing checklist/);
	assert.match(html, /In progress/);
	assert.match(html, /Pending/);
	assert.match(html, /Verify &lt;script&gt;/);
});
