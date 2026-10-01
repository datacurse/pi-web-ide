import { test } from "node:test";
import assert from "node:assert/strict";
import { addPastedText, isLargePaste, joinPastedText, splitPastedText } from "./pastedText.js";

test("only large text pastes become attachments", () => {
	assert.equal(isLargePaste("x".repeat(1999)), false);
	assert.equal(isLargePaste("x".repeat(2000)), true);
	assert.equal(isLargePaste("line\r\n".repeat(19)), true);
	assert.equal(isLargePaste("line\n".repeat(18)), false);
});

test("pasted text round trips exactly with markdown, fences and trailing whitespace", () => {
	const items = [
		{ name: "Pasted text 1.txt", text: "\n```ts\nconst x = `a`;\n```\n\n````pwi-pasted-text Pasted text 2.txt\nhello\n````\n  " },
		{ name: "Pasted text 2.txt", text: "\r\nsecond\r\n" },
	];
	assert.deepEqual(splitPastedText(joinPastedText("some request", items)), { text: "some request", attachments: items });
	assert.deepEqual(splitPastedText(joinPastedText("", items).trim()), { text: "", attachments: items });
	assert.equal(joinPastedText("unchanged\n", []), "unchanged\n");
});

test("large paste replaces the selected text without exposing the attachment in the field", () => {
	const value = addPastedText("before SELECT after", "large paste", 7, 13);
	const parsed = splitPastedText(value);
	assert.equal(parsed.text, "before  after");
	assert.deepEqual(parsed.attachments, [{ name: "Pasted text 1.txt", text: "large paste" }]);
	const next = splitPastedText(addPastedText(value, "next paste", 0, 0));
	assert.equal(next.attachments[1].name, "Pasted text 2.txt");
	assert.equal(next.attachments[0].text, "large paste");
});

test("editing and removing attachments retains remaining content", () => {
	const value = addPastedText(addPastedText("request", "one", 0, 0), "two", 0, 0);
	const parsed = splitPastedText(value);
	const remaining = [{ ...parsed.attachments[1], text: "edited" }];
	assert.deepEqual(splitPastedText(joinPastedText(parsed.text, remaining)), { text: "request", attachments: remaining });
	assert.equal(joinPastedText(parsed.text, []), "request");
});

test("malformed or non-trailing attachment markers remain visible as ordinary text", () => {
	for (const value of ["plain text", "\n\n```pwi-pasted-text Pasted text 1.txt\nmissing end", "\n\n```pwi-pasted-text Pasted text 1.txt\nx\n```\nmore"]) {
		assert.deepEqual(splitPastedText(value), { text: value, attachments: [] });
	}
});
