import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { tasks } from "../tasks.mjs";
import { budget, cleanupSandbox, createParticipant, gradeCandidate, groups, inspectChanges, parseGrade, participantPrompt, runCase, summarize } from "../runner.mjs";
import { createToolTiming } from "../timing.mjs";
import { clientArguments, clientDriver, createClientEventReader } from "../client-drivers.mjs";
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");

test("timing merges overlapping tools and labels remaining time without calling it inference",()=>{
  const timing=createToolTiming();
  timing.start("a",0);timing.start("b",5);timing.end("a",10);timing.end("b",15);timing.end("unseen",16);
  const result=timing.summarize(20);
  assert.equal(result.toolActiveMs,15);
  assert.equal(result.otherElapsedMs,5);
  assert.deepEqual(result.unmatchedCompletions,["unseen"]);
});

test("synthetic Claude and Gemini streams require terminal success and preserve tool timing",()=>{
  const final={completed:true,summary:"fixture only",tests:["fixture"]};
  for(const client of ["claude","gemini"]){
    const timing=createToolTiming(),reader=createClientEventReader(client,timing);
    if(client==="claude"){
      reader.accept({type:"stream_event",event:{type:"content_block_start",content_block:{type:"tool_use",id:"t1"}}},2);
      reader.accept({type:"assistant",message:{content:[{type:"tool_use",id:"t1"}]}},3);
      reader.accept({type:"user",message:{content:[{type:"tool_result",tool_use_id:"t1"}]}},7);
      assert.equal(reader.finish().protocolSuccess,false);
      reader.accept({type:"result",subtype:"success",is_error:false,structured_output:final,usage:{input_tokens:10,cache_read_input_tokens:5,output_tokens:2}},10);
      assert.equal(reader.finish().usage.input_tokens,15);
    }else{
      reader.accept({type:"message",role:"assistant",content:"progress",delta:true},1);
      reader.accept({type:"tool_use",tool_id:"t1"},2);
      reader.accept({type:"tool_result",tool_id:"t1"},7);
      reader.accept({type:"message",role:"assistant",content:JSON.stringify(final),delta:true},8);
      assert.equal(reader.finish().protocolSuccess,false);
      reader.accept({type:"result",status:"success",stats:{unknownFormat:true}},10);
      assert.equal(reader.finish().usage,null);
    }
    assert.equal(reader.toolCalls,1);
    assert.equal(reader.finish().protocolSuccess,true);
    assert.deepEqual(reader.finish().final,final);
    assert.equal(timing.summarize(10).toolActiveMs,5);
  }
  const claude=clientArguments("claude","test-model",budget);
  assert.equal(claude.includes("--dangerously-skip-permissions"),false);
  assert.equal(claude[claude.indexOf("--allowedTools")+1].includes("harness.mjs install"),false);
  assert.equal(clientArguments("gemini","test-model",budget).includes("--sandbox"),true);
});

test("synthetic fatal errors cannot be hidden by a later success, while explicit warnings remain visible",()=>{
  for(const client of ["claude","gemini"]){
    const final={completed:true,summary:"synthetic fixture",tests:[]};
    const terminal=client==="claude"?{type:"result",subtype:"success",is_error:false,structured_output:final,usage:{}}:{type:"result",status:"success",response:JSON.stringify(final)};
    const failure=createClientEventReader(client,createToolTiming());
    failure.accept({type:"error",message:"fatal"},1);failure.accept(terminal,2);
    assert.equal(failure.finish().protocolSuccess,false);
    assert.equal(failure.finish().errors.length,1);
    assert.equal(failure.finish().usage,null);
    const warning=createClientEventReader(client,createToolTiming());
    warning.accept({type:"error",severity:"warning",message:"non-fatal"},1);warning.accept(terminal,2);
    assert.equal(warning.finish().protocolSuccess,true);
    assert.equal(warning.finish().warnings.length,1);
  }
});

test("a synthetic CLI process with corrupt JSONL cannot claim complete despite exit zero",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"ai-harness-driver-fixture-"));
  try{
    const shim=path.join(directory,"synthetic-cli.mjs");
    const terminal={type:"result",subtype:"success",is_error:false,structured_output:{completed:true,summary:"synthetic fixture only",tests:[]}};
    await writeFile(shim,`console.log("broken-json-line"); console.log(${JSON.stringify(JSON.stringify(terminal))});\n`);
    const result=await clientDriver("claude",shim)({root:directory,model:"synthetic-fixture",prompt:"No model service is used in this test.",budget:{timeoutMs:5000,maxToolCalls:5},outputDirectory:directory});
    assert.equal(result.exitCode,0);
    assert.equal(result.unparsedLines,1);
    assert.equal(result.completed,false);
  }finally{
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-driver-fixture-"));
    await rm(directory,{recursive:true,force:true});
  }
});

test("hidden judges accept all reference contracts and reject incomplete implementations",async()=>{
  for(const task of tasks){
    const reference=await gradeCandidate(task,task.reference);
    assert.equal(reference.ok,true,JSON.stringify(reference));
    assert.equal(reference.cases.length,task.cases.length);
    assert.equal((await gradeCandidate(task,task.files[task.entry])).ok,false);
  }
});

test("exit zero, missing or duplicate tests cannot impersonate a completed acceptance run",async()=>{
  assert.equal((await gradeCandidate(tasks[0],`process.exit(0);export function parseCsv(){return [];}`)).ok,false);
  assert.equal(parseGrade('MARK{"cases":[{"id":"one","pass":true}]}',"MARK",["one","two"],0).ok,false);
  assert.equal(parseGrade('MARK{"cases":[{"id":"one","pass":true},{"id":"one","pass":true}]}',"MARK",["one","two"],0).ok,false);
});

test("all groups share contracts and budgets, while hidden cases and references stay outside participant files",async()=>{
  assert.equal(budget.timeoutMs,180000);
  const matrix=groups("weak","strong");
  assert.equal(matrix[0].model,matrix[1].model);
  for(const group of matrix){
    const participant=await createParticipant(tasks[0],{sourceRoot,harness:group.harness});
    try{
      for(const [file,content]of Object.entries(tasks[0].files))assert.equal(await readFile(path.join(participant.root,file),"utf8"),content);
      assert.equal((await readdir(participant.root)).includes("benchmarks"),false);
      assert.match(participantPrompt(tasks[0],group),/180秒、80次/);
      assert.equal((await inspectChanges(participant,tasks[0],group.harness)).ok,true);
      await writeFile(path.join(participant.root,"TASK.md"),"weakened task");
      assert.deepEqual((await inspectChanges(participant,tasks[0],group.harness)).violations,["TASK.md"]);
    }finally{await cleanupSandbox(participant.root);}
  }
});

test("a simulated driver exercises grading and false completion without becoming a real model result",async()=>{
  const output=await mkdtemp(path.join(tmpdir(),"ai-harness-bench-test-"));
  try{
    const row=await runCase({task:tasks[0],group:groups("weak","strong")[0],sourceRoot,outputDirectory:output,
      driver:async()=>({mode:"simulated",completed:true,final:{completed:true},durationMs:1,usage:null})});
    assert.equal(row.falseFunctionalCompletion,true);
    assert.equal(row.success,false);
    assert.equal(summarize([row])[0].completed,0);
    assert.throws(()=>summarize([row,{...row,mode:"real"}]));
  }finally{
    const resolved=path.resolve(output);
    assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ai-harness-bench-test-"));
    await rm(resolved,{recursive:true,force:true});
  }
});
