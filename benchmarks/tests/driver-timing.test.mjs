import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clientDriver } from "../client-drivers.mjs";
import { createToolTiming } from "../timing.mjs";

const final={completed:true,summary:"synthetic lifecycle fixture",tests:[]};
function terminal(client){
  return client === "codex" ? {type:"turn.completed",usage:{input_tokens:0,output_tokens:0}}
    : client === "claude" ? {type:"result",subtype:"success",is_error:false,structured_output:final}
      : {type:"result",status:"success",response:JSON.stringify(final)};
}
function tool(client,start){
  return client === "codex" ? {type:start?"item.started":"item.completed",item:{id:"t1",type:"command_execution",command:"node --test",status:start?"in_progress":"completed"}}
    : client === "claude" ? {type:start?"assistant":"user",message:{content:[start?{type:"tool_use",id:"t1"}:{type:"tool_result",tool_use_id:"t1"}]}}
      : {type:start?"tool_use":"tool_result",tool_id:"t1"};
}

for(const client of ["codex","claude","gemini"]){
  for(const scenario of ["normal","await-response","await-exit","exit-before-close","buffered-terminal","spawn-error"]){
    test(client+" lifecycle distinguishes "+scenario+" without changing completion rules",async(context)=>{
      const directory=await realpath(await mkdtemp(path.join(tmpdir(),"ai-harness-driver-timing-")));
      const child=new EventEmitter();child.pid=scenario==="spawn-error"?undefined:123456;child.exitCode=null;
      child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
      let now=1000,timer=null,stops=0;
      const at=value=>{now=1000+value;};
      const emit=(event,value,newline=true)=>{at(value);child.stdout.write(JSON.stringify(event)+(newline?"\n":""));};
      const exit=value=>{at(value);child.exitCode=scenario.startsWith("await-")?1:0;child.emit("exit",child.exitCode,null);};
      const close=value=>{at(value);child.stdout.end();child.stderr.end();child.emit("close",child.exitCode);};
      const stopped=()=>{stops++;exit(40);close(45);return true;};
      try{
        await writeFile(path.join(directory,"final.json"),JSON.stringify(final));
        context.mock.method(Date,"now",()=>now);
        context.mock.method(globalThis,"setTimeout",callback=>{timer=callback;return 1;});
        context.mock.method(globalThis,"clearTimeout",()=>{});
        context.mock.method(childProcess,"spawnSync",()=>{stopped();return {status:0};});
        context.mock.method(process,"kill",()=>stopped());
        context.mock.method(childProcess,"spawn",()=>{
          queueMicrotask(()=>{
            if(scenario==="spawn-error"){
              at(3);child.emit("error",Object.assign(new Error("synthetic missing executable"),{code:"ENOENT"}));close(16);return;
            }
            emit({type:"system"},2);emit(tool(client,true),5);emit(tool(client,false),7);
            if(scenario!=="await-response")emit(terminal(client),10,scenario!=="buffered-terminal");
            if(scenario.startsWith("await-")){at(30);timer();}
            else{exit(12);close(scenario==="exit-before-close"?26:16);}
          });
          return child;
        });
        syncBuiltinESMExports();
        const result=await clientDriver(client,"synthetic.mjs")({root:directory,model:"synthetic",prompt:"No model or network calls",budget:{timeoutMs:1000,maxToolCalls:80},outputDirectory:directory});
        const points=result.timing.lifecycle;
        assert.equal(points?.version,1,"lifecycle points must be an explicit optional measurement version");
        assert.equal(points.firstProtocolEventMs,scenario==="spawn-error"?null:2,"absent output is unknown rather than zero latency");
        assert.equal(points.terminalEventMs,["await-response","spawn-error"].includes(scenario)?null:scenario==="buffered-terminal"?16:10);
        assert.equal(points.processExitMs,scenario==="spawn-error"?null:scenario.startsWith("await-")?40:12);
        assert.equal(points.processCloseMs,scenario.startsWith("await-")?45:scenario==="exit-before-close"?26:16);
        assert.equal(result.completed,!["await-response","await-exit","spawn-error"].includes(scenario),"receiving a final response cannot override timeout or launch failure");
        assert.equal(result.timedOut,scenario.startsWith("await-"));
        assert.equal(stops,scenario.startsWith("await-")?1:0,"observability must not introduce cancellation or budget changes");
        if(scenario!=="spawn-error")assert.equal(result.timing.spans[0].endMs,7,"existing tool intervals keep their original meaning");
      }finally{
        context.mock.restoreAll();syncBuiltinESMExports();
        assert.equal(path.dirname(directory),await realpath(tmpdir()));assert.ok(path.basename(directory).startsWith("ai-harness-driver-timing-"));
        await rm(directory,{recursive:true,force:true});
      }
    });
  }
}

test("protocol timing preserves zero and uses the last terminal event like the protocol reader",()=>{
  const timing=createToolTiming();timing.protocol(0,false);timing.protocol(3,true);timing.protocol(4,true);timing.exited(5);timing.closed(6);
  assert.deepEqual(timing.summarize(6).lifecycle,{version:1,firstProtocolEventMs:0,terminalEventMs:4,processExitMs:5,processCloseMs:6});
});
