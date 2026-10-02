import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerActions, UserMessage } from "./Transcript.js";

test("user prompts retain literal text, attachment thumbnails, copy/edit and their timestamp", () => {
	const html = renderToStaticMarkup(createElement(UserMessage, {
		at: 1000, userMode: "full", onEdit: () => {},
		blocks: [
			{ kind: "text", text: "**literal** <script>never execute</script>" },
			{ kind: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		],
	}));
	assert.match(html, /\*\*literal\*\*/);
	assert.match(html, /&lt;script&gt;never execute&lt;\/script&gt;/);
	assert.doesNotMatch(html, /<strong>|<script>/);
	assert.match(html, /data:image\/png;base64,aW1hZ2U=/);
	assert.match(html, /Copy/);
	assert.match(html, /Edit/);
	assert.match(html, /msg-footer-time/);
	assert.ok(html.indexOf("data:image") < html.indexOf("literal"), "attachments remain above text");
});

test("final answer actions retain copy and fork controls without the retired timing renderer", () => {
	const html = renderToStaticMarkup(createElement(AnswerActions, {
		at: 2000, text: "answer", onFork: async () => {},
	}));
	assert.match(html, /Copy/);
	assert.match(html, /Fork from here/);
	assert.doesNotMatch(html, /Breakdown|Round|progressbar/);
});
