import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { BookOpen, NotePencil, TerminalWindow } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { Tool, ToolIcon } from "./Transcript.js";

const children = [
	{id:"p/1",name:"read",args:{path:"a.ts"},result:"secret child output",durationMs:120},
	{id:"p/2",name:"bash",args:{command:"pnpm test"},result:"exit 1",isError:true,durationMs:250},
];
test("codemode is a context label, not another fold or indented layer", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",result:"done",autoOpen:false,ms:400,children,childrenIncomplete:true}));
	assert.match(html,/via codemode/);
	assert.match(html,/1 failed/);
	assert.match(html,/Partial batch/);
	assert.match(html,/400ms/);
	assert.match(html,/a\.ts/);
	assert.match(html,/pnpm test/);
	assert.equal((html.match(/aria-expanded="false"/g)??[]).length,2);
	assert.doesNotMatch(html,/secret child output|border-l|aria-expanded="true"|Explore|Modify|Verify/);
});
test("expanded work opens completed child details without exposing the codemode wrapper", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:"HIDDEN_AGGREGATE",args:{code:"HIDDEN_SCRIPT"},children,expandedByDefault:true}));
	assert.equal((html.match(/aria-expanded="true"/g)??[]).length,2);
	assert.match(html,/secret child output/);
	assert.match(html,/pnpm test/);
	assert.doesNotMatch(html,/HIDDEN_AGGREGATE|HIDDEN_SCRIPT/);
	const folded = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:"done",children,expandedByDefault:false}));
	assert.equal((folded.match(/aria-expanded="false"/g)??[]).length,2);
	assert.doesNotMatch(folded,/secret child output/);
});

test("tool types have distinct read, write, and command icons", () => {
	assert.equal(ToolIcon({name:"read"}).type,BookOpen);
	assert.equal(ToolIcon({name:"read_symbol"}).type,BookOpen);
	assert.equal(ToolIcon({name:"write"}).type,NotePencil);
	assert.equal(ToolIcon({name:"edit"}).type,NotePencil);
	assert.equal(ToolIcon({name:"bash"}).type,TerminalWindow);
});
test("file paths stay visible instead of being replaced with a source-code preview", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"read",args:{path:"a.ts"},result:"secret child output",autoOpen:false,ms:120}));
	assert.match(html,/a\.ts/);
	assert.match(html,/120ms/);
	assert.doesNotMatch(html,/secret child output/);
});
test("codemode cards omit the script and aggregate output even without retained children", () => {
	for (const open of [false,true]) for (const calls of [children,undefined]) {
		const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:open,running:open,args:{code:"REDUNDANT_SCRIPT"},result:"REDUNDANT_AGGREGATE_OUTPUT",children:calls,ms:400}));
		assert.doesNotMatch(html,/REDUNDANT_SCRIPT|REDUNDANT_AGGREGATE_OUTPUT/);
		assert.match(html,/via codemode/);
		assert.match(html,/400ms/);
		if(calls) assert.match(html,/1 failed/);
	}
	const failed = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:"hidden error output",isError:true}));
	assert.match(failed,/aria-label="failed"/);
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
test("interrupted retained calls never look successful or still running", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"read",autoOpen:false,result:"",interrupted:true}));
	assert.match(html,/Interrupted/);
	assert.doesNotMatch(html,/text-green-400/);
});
