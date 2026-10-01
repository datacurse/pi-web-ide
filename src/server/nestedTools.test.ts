import assert from "node:assert/strict";
import { test } from "node:test";
import { stitch, toEvents, toPiMessage } from "./agent.js";

test("live nested IDs and timestamps survive the RPC adapter", () => {
	const start = toEvents({type:"tool_execution_start",toolCallId:"batch/1",parentToolCallId:"batch",toolName:"read",args:{path:"a.ts"}})[0];
	assert.ok(start.type === "tool_start");
	assert.equal(start.parentId,"batch");
	assert.equal(typeof start.at,"number");
	const end = toEvents({type:"tool_execution_end",toolCallId:"batch/1",parentToolCallId:"batch",toolName:"read",result:{content:[]}})[0];
	assert.ok(end.type === "tool_end" && typeof end.at === "number");
});
test("bounded saved nested calls stitch onto the model-issued parent across reloads", () => {
	const call = toPiMessage({role:"assistant",timestamp:1,content:[{type:"toolCall",id:"batch",name:"codemode",arguments:{code:"..."}}]});
	const result = toPiMessage({role:"toolResult",toolCallId:"batch",toolName:"codemode",timestamp:2,content:[{type:"text",text:"completed"}],nestedCalls:{complete:false,calls:[
		{id:"batch/1",name:"read",arguments:{path:"a.ts"},status:"ok",durationMs:12},
		{id:"batch/2",name:"codemode",arguments:{},status:"ok",durationMs:25},
		{id:"batch/2/1",name:"bash",arguments:{command:"pnpm test"},status:"error",error:"exit 1",durationMs:20},
		{id:"batch/3",name:"read",arguments:{path:"b.ts"},status:"running"},
	]}});
	const block = stitch([call,result])[0].blocks[0];
	assert.ok(block.kind === "tool");
	assert.equal(block.result,"completed");
	assert.equal(block.childrenIncomplete,true);
	assert.equal(block.children?.length,3);
	assert.equal(block.children?.[0].durationMs,12);
	assert.equal(block.children?.[0].outputUnavailable,true);
	assert.equal(block.children?.[1].children?.[0].isError,true);
	assert.equal(block.children?.[1].children?.[0].result,"exit 1");
	assert.equal(block.children?.[2].interrupted,true);
});
test("untrusted nested metadata rejects invalid entries, caps size, and never invents durations", () => {
	const calls = Array.from({length:300},(_,i)=>({id:"p/"+i,name:"read",status:"ok",durationMs:Infinity}));
	const block = toPiMessage({role:"toolResult",toolCallId:"p",nestedCalls:{complete:true,calls:[null,{},...calls]},content:[]}).blocks[0];
	assert.ok(block.kind === "tool");
	assert.equal(block.children?.length,255);
	assert.equal(block.childrenIncomplete,true);
	assert.ok(block.children?.every(c=>c.durationMs === undefined));
});
