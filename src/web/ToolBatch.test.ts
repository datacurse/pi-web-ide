import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Tool } from "./Transcript.js";

const children = [
	{id:"p/1",name:"read",args:{path:"a.ts"},result:"secret child output",durationMs:120},
	{id:"p/2",name:"bash",args:{command:"pnpm test"},result:"exit 1",isError:true,durationMs:250},
];
test("collapsed batches show counts, duration, failures and retention gaps without duplicating child output", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",result:"done",autoOpen:false,ms:400,children,childrenIncomplete:true}));
	assert.match(html,/aria-expanded="false"/);
	assert.match(html,/read × 1/);
	assert.match(html,/bash × 1/);
	assert.match(html,/1 failed/);
	assert.match(html,/Partial batch/);
	assert.match(html,/0\.4s/);
	assert.doesNotMatch(html,/secret child output|Explore|Modify|Verify/);
});
test("opening a running batch reveals collapsed children with measured timings and useful targets", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:true,children:[{...children[0],result:"",outputUnavailable:true},children[1]]}));
	assert.match(html,/aria-expanded="true"/);
	assert.match(html,/aria-expanded="false"/);
	assert.match(html,/a\.ts/);
	assert.match(html,/0\.1s/);
	assert.match(html,/0\.3s/);
	assert.doesNotMatch(html,/secret child output/);
});
test("codemode cards omit the script and aggregate output whether open, collapsed, or without retained children", () => {
	for (const open of [false,true]) for (const calls of [children,undefined]) {
		const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:open,running:open,args:{code:"REDUNDANT_SCRIPT"},result:"REDUNDANT_AGGREGATE_OUTPUT",children:calls,ms:400}));
		assert.doesNotMatch(html,/REDUNDANT_SCRIPT|REDUNDANT_AGGREGATE_OUTPUT/);
		assert.match(html,/codemode/);
		assert.match(html,/0\.4s/);
		if(calls) {
			assert.match(html,/read × 1/);
			assert.match(html,/1 failed/);
			if(open) assert.match(html,/exit 1/);
		}
	}
});
test("ordinary calls still show their own arguments and output when opened", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"bash",autoOpen:true,running:true,args:{command:"pnpm test"},result:"ACTUAL_TOOL_OUTPUT"}));
	assert.match(html,/pnpm test/);
	assert.match(html,/ACTUAL_TOOL_OUTPUT/);
});
test("retention gaps are explicit and partial output does not stop a running child", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"read",autoOpen:true,result:"partial body",running:true,outputUnavailable:true}));
	assert.match(html,/aria-expanded="true"/);
	assert.match(html,/Nested output was not retained/);
	assert.match(html,/partial body/);
	assert.doesNotMatch(html,/text-green-400/);
});
test("a running child's elapsed time uses its own start marker even without a parent clock", (t) => {
	t.mock.method(Date,"now",()=>5000);
	const html = renderToStaticMarkup(createElement(Tool,{name:"read",autoOpen:false,result:"partial",running:true,startedAt:1000}));
	assert.match(html,/4\.0s/);
	assert.doesNotMatch(html,/text-green-400/);
});
test("interrupted retained calls never look like successful or still-running calls", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"read",autoOpen:false,result:"",interrupted:true}));
	assert.match(html,/Interrupted/);
	assert.doesNotMatch(html,/text-green-400/);
});
