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
test("codemode wrapper adds no row; nested tools render directly", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",result:"done",autoOpen:false,ms:400,children,childrenIncomplete:true}));
	assert.doesNotMatch(html,/via codemode|400ms/);
	assert.match(html,/Some nested calls were not retained/);
	assert.match(html,/a\.ts/);
	assert.match(html,/pnpm test/);
	assert.equal((html.match(/aria-expanded="false"/g)??[]).length,1);
	assert.doesNotMatch(html,/secret child output|border-l|Explore|Modify|Verify/);
});
test("expanded work opens completed child details without exposing the codemode wrapper", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:"HIDDEN_AGGREGATE",args:{code:"HIDDEN_SCRIPT"},children,expandedByDefault:true}));
	assert.equal((html.match(/aria-expanded="true"/g)??[]).length,2);
	assert.match(html,/secret child output/);
	assert.match(html,/pnpm test/);
	assert.doesNotMatch(html,/HIDDEN_AGGREGATE|HIDDEN_SCRIPT/);
	const folded = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:"done",children,expandedByDefault:false}));
	assert.equal((folded.match(/aria-expanded="false"/g)??[]).length,1);
	assert.doesNotMatch(folded,/secret child output|HIDDEN_AGGREGATE/);
});

test("tool types have distinct read, write, and command icons", () => {
	assert.equal(ToolIcon({name:"read"}).type,BookOpen);
	assert.equal(ToolIcon({name:"read_symbol"}).type,BookOpen);
	assert.equal(ToolIcon({name:"write"}).type,NotePencil);
	assert.equal(ToolIcon({name:"edit"}).type,NotePencil);
	assert.equal(ToolIcon({name:"bash"}).type,TerminalWindow);
});
test("source-reading output strips anchors and common indentation before rendering code", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"read",args:{path:"src/a.ts"},result:"Ab12│        const answer = 42;\nCd34│            return answer;",autoOpen:false,expandedByDefault:true}));
	assert.match(html,/const answer = 42;/);
	assert.match(html,/>    return answer;/);
	assert.doesNotMatch(html,/Ab12│|Cd34│| {8}const answer/);
});
test("file paths stay visible instead of being replaced with a source-code preview", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"read",args:{path:"a.ts"},result:"secret child output",autoOpen:false,ms:120}));
	assert.match(html,/a\.ts/);
	assert.match(html,/120ms/);
	assert.doesNotMatch(html,/secret child output/);
});
test("codemode keeps the script hidden and shows combined output with its command", () => {
	for (const open of [false,true]) for (const calls of [children,undefined]) {
		const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:open,running:open,args:{code:"REDUNDANT_SCRIPT"},result:"REDUNDANT_AGGREGATE_OUTPUT",children:calls,ms:400}));
		assert.doesNotMatch(html,/REDUNDANT_SCRIPT/);
		assert.doesNotMatch(html,/REDUNDANT_AGGREGATE_OUTPUT/);
		assert.doesNotMatch(html,/via codemode|400ms/);
		if(calls) assert.match(html,/text-red-400/);
	}
	const failed = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:"hidden error output",isError:true}));
	assert.match(failed,/text-red-400/);
	assert.match(failed,/>failed</);
});
test("a single nested command owns the codemode aggregate output without a false retention warning", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:"Script completed\nOutput:\nhello",children:[
		{id:"p/1",name:"bash",args:{command:"echo hello"},result:"",outputUnavailable:true},
	],expandedByDefault:true}));
	assert.match(html,/echo hello/);
	assert.match(html,/hello/);
	assert.doesNotMatch(html,/Script completed|Wall time|Output:|Nested output was not retained|via codemode/);
	assert.equal((html.match(/hello/g)??[]).length,2);
	assert.equal((html.match(/echo hello/g)??[]).length,1);
});

test("serialized outputs map to their matching nested bash calls without wrapper metadata", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"codemode",autoOpen:false,result:[
		JSON.stringify({output:"stdout one\n",exit_code:0,wall_time_seconds:2}),
		JSON.stringify({output:"stdout two\n",exit_code:0,wall_time_seconds:1}),
	].join("\n"),children:[
		{id:"p/1",name:"bash",args:{command:"first"},result:"",outputUnavailable:true,durationMs:2100},
		{id:"p/2",name:"bash",args:{command:"second"},result:"",outputUnavailable:true,durationMs:1100},
	],expandedByDefault:true}));
	assert.match(html,/first/);
	assert.match(html,/second/);
	assert.match(html,/stdout one/);
	assert.match(html,/stdout two/);
	assert.ok(html.indexOf(">first<") < html.indexOf("stdout one"));
	assert.ok(html.indexOf(">second<") < html.indexOf("stdout two"));
	assert.equal((html.match(/aria-expanded="true"/g)??[]).length,2);
	assert.doesNotMatch(html,/"output"|exit_code|wall_time_seconds|Nested output was not retained/);
});

test("ordinary calls still show their own arguments and output when opened", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"bash",autoOpen:true,running:true,args:{command:"pnpm test"},result:"ACTUAL_TOOL_OUTPUT"}));
	assert.match(html,/pnpm test/);
	assert.match(html,/ACTUAL_TOOL_OUTPUT/);
});
test("unified diffs in command output highlight additions and removals", () => {
	const html = renderToStaticMarkup(createElement(Tool,{name:"bash",autoOpen:true,args:{command:"git diff"},result:[
		"diff --git a/file.ts b/file.ts",
		"index abc..def 100644",
		"@@ -1 +1 @@",
		"-before",
		"+after",
	].join("\n"),expandedByDefault:true}));
	assert.match(html,/text-neutral-500[^>]*>diff --git/);
	assert.match(html,/text-red-400[^>]*>-before/);
	assert.match(html,/text-green-400[^>]*>\+after/);
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
