import test,{before,after} from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs,{cp,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,symlink,writeFile} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { experimentPlan,runExperiment } from "../experiment.mjs";
import { projectTasks } from "../project-tasks.mjs";
import { hash } from "../runner.mjs";
import { executionSummary,readExecution } from "../execution.mjs";
import { withFileLock } from "../../.ai-harness/src/locking.mjs";

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const report=async outputDirectory=>(await import("../report.mjs")).createComparisonReport({outputDirectory});
const json=async file=>JSON.parse(await readFile(file,"utf8"));
let directory,base;

async function fixture(outputDirectory,{comparison="paired",repetitions=2,weak="synthetic"}={}){
  const plan=experimentPlan({weak,strong:"synthetic-reference",suite:"project",comparison,repetitions,timeoutMs:5000});let calls=0;
  await runExperiment({plan,sourceRoot,outputDirectory,mode:"simulated",driver:async({root,outputDirectory:out})=>{
    const entry=plan.schedule[calls++],harness=entry.group==="weak-harness",timeout=!harness&&entry.trial===2;
    if(!(harness&&entry.trial===1))for(const [file,content]of Object.entries(projectTasks[0].reference))await writeFile(path.join(root,file),content);
    await writeFile(path.join(out,"events.jsonl"),'{"type":"synthetic"}\n');
    return {mode:"simulated",client:"codex",completed:!timeout,timedOut:timeout,toolLimit:false,exitCode:0,unparsedLines:0,errors:[],protocolSuccess:true,
      final:timeout?null:{completed:true,summary:"private-answer-canary",tests:[]},
      durationMs:timeout?5000:harness?entry.trial*10+10:10,toolCalls:harness?3:2,
      usage:timeout?null:{input_tokens:harness?entry.trial===1?80:200:100,output_tokens:harness?entry.trial===1?30:50:20},
      timing:timeout?null:{basis:"local-event-receive-time",toolActiveMs:5,otherElapsedMs:5,categories:{verification:{calls:1,activeMs:5}}}};
  }});
}
before(async()=>{directory=await mkdtemp(path.join(tmpdir(),"ai-harness-report-"));base=path.join(directory,"base");await fixture(base);});
after(async()=>{const target=await realpath(directory);assert.equal(path.dirname(target),await realpath(tmpdir()));assert.ok(path.basename(target).startsWith("ai-harness-report-"));await rm(target,{recursive:true,force:true});});
async function copy(){const out=path.join(directory,randomUUID());await cp(base,out,{recursive:true});return out;}
async function tree(root){
  const output={};
  async function walk(folder,prefix=""){
    for(const entry of await readdir(folder,{withFileTypes:true})){
      const relative=prefix+entry.name,absolute=path.join(folder,entry.name);
      if(entry.isSymbolicLink())output[relative]="link";
      else if(entry.isDirectory()){output[relative+"/"]="directory";await walk(absolute,relative+"/");}
      else output[relative]=hash(await readFile(absolute));
    }
  }
  await walk(root);return output;
}
async function unchanged(t,out,action){
  const original=await tree(out);let writes=0;
  for(const name of ["writeFile","appendFile","mkdir","rename","rm","unlink","rmdir","copyFile"]){t.mock.method(fs,name,async()=>{writes++;throw new Error("report attempted a write");});}
  syncBuiltinESMExports();let result;
  try{result=await action();assert.equal(writes,0);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(await tree(out),original);return result;
}
async function rewriteRow(out,index,mutate,{refreshSummary=true}={}){
  const protocol=await json(path.join(out,"protocol.json")),ledger=await json(path.join(out,"execution.json"));
  const file=path.join(out,protocol.schedule[index].directory,"result.json"),row=await json(file);mutate(row);
  row.success=Boolean(row.run.completed&&row.scope.ok&&row.grade.ok&&(row.group!=="weak-harness"||row.workflow?.ok));
  row.falseCompletion=Boolean(row.run.final?.completed&&!row.success);
  await writeFile(file,JSON.stringify(row));ledger.trials[index].resultSha256=hash(await readFile(file));
  await writeFile(path.join(out,"execution.json"),JSON.stringify(ledger));
  if(refreshSummary){
    const recovered=await readExecution(out,protocol);
    await writeFile(path.join(out,"summary.json"),JSON.stringify(executionSummary(protocol,recovered.ledger,recovered.rows,protocol.source)));
  }
}

test("paired reports align rotated schedules and distinguish functional from full delivery",async(t)=>{
  const value=await unchanged(t,base,()=>report(base));
  assert.equal(value.ok,true);assert.equal(value.readOnly,true);assert.equal(value.mode,"simulated");
  assert.deepEqual(value.pairs.map(pair=>pair.trial),[1,2]);
  assert.deepEqual(value.summary.outcomes.functional,{baselineOnly:1,harnessOnly:0,bothPass:1,bothFail:0});
  assert.deepEqual(value.summary.outcomes.sharedDelivery,{baselineOnly:1,harnessOnly:1,bothPass:0,bothFail:0});
  assert.deepEqual(value.summary.outcomes.fullDelivery,{baselineOnly:1,harnessOnly:0,bothPass:0,bothFail:1});
  assert.equal(value.pairs[0].delta.durationMs,10);assert.equal(value.pairs[1].delta.durationMs,-4970);
  assert.equal(value.pairs[1].baseline.censored,true);assert.equal(value.summary.censoredPairs,1);
  assert.ok(value.pairs[0].harness.failures.includes("functional-failed"));
  assert.ok(value.pairs[1].harness.failures.includes("workflow-incomplete"));
  assert.doesNotMatch(JSON.stringify(value),/private-answer-canary/);
});

test("each metric keeps its own coverage and missing usage never becomes a zero saving",async()=>{
  const value=await report(base);
  assert.equal(value.pairs[0].delta.inputTokens,-20);assert.equal(value.pairs[0].delta.outputTokens,10);
  assert.equal(value.pairs[1].delta.inputTokens,null);assert.equal(value.pairs[1].baseline.measurements.inputTokens,null);
  assert.deepEqual(value.summary.measurements.inputTokens,{pairedSamples:1,unknownPairs:1,medianDelta:-20});
  assert.equal(value.summary.measurements.durationMs.medianDelta,-2480);
  assert.equal(value.summary.timings.baseline.unknownSamples,1);
  assert.equal(value.summary.timings.harness.categories.find(row=>row.category==="verification").activeMs,10);
  const out=await copy();await rewriteRow(out,0,row=>{row.run.usage={input_tokens:0,output_tokens:0};row.run.durationMs=0;row.run.toolCalls=0;});
  const zero=await report(out);assert.equal(zero.ok,true);assert.equal(zero.pairs[0].baseline.measurements.inputTokens,0);
  assert.equal(zero.pairs[0].delta.durationMs,20);
});

test("corrupt results and missing summaries cannot produce a partial comparison",async(t)=>{
  for(const file of ["summary.json","execution.json","protocol.json"]){
    const out=await copy();await writeFile(path.join(out,file),"private-broken-canary");
    const value=await unchanged(t,out,()=>report(out));assert.equal(value.ok,false);assert.equal(value.error.code,"INVALID_EVIDENCE");
    assert.equal(value.pairs,undefined);assert.doesNotMatch(JSON.stringify(value),/private-broken-canary/);
  }
  const out=await copy();await rm(path.join(out,"summary.json"));assert.equal((await report(out)).ok,false);
});

test("unfinished and historical experiments stay blocked even when results are present",async()=>{
  for(const defect of ["unfinished","legacy","pair"]){
    const out=await copy();
    if(defect==="unfinished"){
      const ledger=await json(path.join(out,"execution.json"));ledger.trials[0].status="started";delete ledger.trials[0].resultSha256;
      await writeFile(path.join(out,"execution.json"),JSON.stringify(ledger));
    }else{
      const protocol=await json(path.join(out,"protocol.json"));
      if(defect==="legacy")protocol.schemaVersion=3;else protocol.schedule.pop();
      await writeFile(path.join(out,"protocol.json"),JSON.stringify(protocol));
    }
    const value=await report(out);assert.equal(value.ok,false);assert.equal(value.pairs,undefined);
    assert.equal(value.error.code,defect==="legacy"?"UNSUPPORTED_PROTOCOL":defect==="unfinished"?"INCOMPLETE_EXPERIMENT":"INVALID_EVIDENCE");
  }
});

test("active locks block reports without touching the writer or reading its results",async(t)=>{
  const out=await copy();
  await withFileLock(path.join(out,".experiment.lock"),async()=>{
    const value=await unchanged(t,out,()=>report(out));assert.equal(value.ok,false);assert.equal(value.error.code,"LOCK_BLOCKED");assert.equal(value.pairs,undefined);
  });
});

test("changes to candidate bytes revoke reports even when the execution ledger does not change",async(t)=>{
  const out=await copy(),protocol=await json(path.join(out,"protocol.json"));
  const candidate=path.join(out,protocol.schedule[0].directory,"candidate-files.json"),original=fs.readFile;let changed=false;
  t.mock.method(fs,"readFile",async(target,...args)=>{
    const bytes=await original(target,...args);
    if(!changed&&path.basename(String(target))==="candidate-files.json"){changed=true;await writeFile(candidate,"changed during report");}
    return bytes;
  });syncBuiltinESMExports();
  try{const value=await report(out);assert.equal(value.ok,false);assert.equal(value.error.code,"CONCURRENT_CHANGE");assert.equal(value.pairs,undefined);}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test("invalid measurements are rejected rather than coerced to zero or leaked in diagnostics",async()=>{
  for(const [invalid,refreshSummary] of [
    [row=>{row.run.durationMs="private-measurement-canary";},true],
    [row=>{row.run.toolCalls=-2;},true],
    [row=>{row.run.usage.input_tokens="12";},true],
    [row=>{row.run.usage.output_tokens=1.5;},true],
    [row=>{row.run.timing.categories.verification.activeMs="12";},true],
    [row=>{row.run.timedOut="false";},true],
    [row=>{row.run.toolLimit="false";},true],
    [row=>{row.run.protocolSuccess="true";},true],
    [row=>{row.run.unparsedLines="0";},true],
    [row=>{row.run.errors="private-error-canary";},true],
    [row=>{row.run.exitCode="0";},true],
    [row=>{row.run.final.completed="false";},false],
    [row=>{row.run.timing.categories=Object.fromEntries([["__proto__",{calls:1,activeMs:2}]]);},false],
  ]){
    const out=await copy();await rewriteRow(out,0,invalid,{refreshSummary});
    const value=await report(out);assert.equal(value.ok,false);assert.equal(value.error.code,"INVALID_MEASUREMENT");
    assert.equal(value.pairs,undefined);assert.doesNotMatch(JSON.stringify(value),/private-measurement-canary/);
    assert.equal(Object.hasOwn(Object.prototype,"calls"),false);
  }
  const out=await copy();
  const protocol=await json(path.join(out,"protocol.json"));
  const harnessIndex=protocol.schedule.findIndex(entry=>entry.group==="weak-harness");
  await rewriteRow(out,harnessIndex,row=>{row.workflow.ok="false";},{refreshSummary:false});
  const invalidWorkflow=await report(out);
  assert.equal(invalidWorkflow.ok,false);assert.equal(invalidWorkflow.error.code,"INVALID_MEASUREMENT");
});

test("absent simulation truncation flags remain unknown rather than claiming an uncensored run",async()=>{
  const out=await copy();await rewriteRow(out,0,row=>{delete row.run.timedOut;delete row.run.toolLimit;});
  const value=await report(out);
  assert.equal(value.ok,true);assert.equal(value.pairs[0].baseline.censored,false);
  assert.equal(value.pairs[0].baseline.censorUnknown,true);
  assert.equal(value.summary.unknownTruncationPairs,1);
});

test("confirmed truncation wins over an unknown flag within and across paired trials",async()=>{
  const same=await copy();
  await rewriteRow(same,0,row=>{row.run.timedOut=true;delete row.run.toolLimit;row.run.completed=false;row.run.final=null;});
  const sameReport=await report(same);
  assert.equal(sameReport.ok,true);
  assert.equal(sameReport.pairs[0].baseline.censored,true);
  assert.equal(sameReport.pairs[0].baseline.censorUnknown,false);
  assert.equal(sameReport.summary.censoredPairs,2);
  assert.equal(sameReport.summary.unknownTruncationPairs,0);

  const across=await copy(),protocol=await json(path.join(across,"protocol.json"));
  const secondHarness=protocol.schedule.findIndex(entry=>entry.group==="weak-harness"&&entry.trial===2);
  await rewriteRow(across,secondHarness,row=>{delete row.run.timedOut;delete row.run.toolLimit;});
  const acrossReport=await report(across);
  assert.equal(acrossReport.ok,true);
  assert.equal(acrossReport.pairs[1].harness.censorUnknown,true);
  assert.equal(acrossReport.summary.censoredPairs,1);
  assert.equal(acrossReport.summary.unknownTruncationPairs,0);
});

test("a reference group is audited but excluded from weak-model pairing",async()=>{
  const out=path.join(directory,randomUUID());await fixture(out,{comparison:"reference",repetitions:1});
  const value=await report(out);assert.equal(value.ok,true);assert.equal(value.experiment.samples,3);
  assert.equal(value.experiment.groups.length,3);assert.equal(value.pairs.length,1);
  assert.equal(value.summary.outcomes.functional.baselineOnly,1);
});

test("a failed audit that races a ledger change is concurrent, not persistent corruption",async(t)=>{
  const out=await copy(),file=path.join(out,"execution.json"),original=fs.readFile;let changed=false;
  t.mock.method(fs,"readFile",async(target,...args)=>{
    const bytes=await original(target,...args);
    if(!changed&&path.basename(String(target))==="summary.json"){
      changed=true;
      const ledger=await json(file);ledger.trials[0].status="started";delete ledger.trials[0].resultSha256;
      await writeFile(file,JSON.stringify(ledger));return Buffer.from("private-failed-summary-canary");
    }
    return bytes;
  });syncBuiltinESMExports();
  try{const value=await report(out);assert.equal(value.ok,false);assert.equal(value.error.code,"CONCURRENT_CHANGE");
    assert.equal(value.pairs,undefined);assert.doesNotMatch(JSON.stringify(value),/private-failed-summary-canary/);}
  finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test("linked trial evidence and unknown locks cannot be reported as trustworthy",async()=>{
  const out=await copy(),protocol=await json(path.join(out,"protocol.json"));
  const trial=path.join(out,protocol.schedule[0].directory),elsewhere=path.join(directory,randomUUID());
  await rename(trial,elsewhere);await symlink(elsewhere,trial,process.platform==="win32"?"junction":"dir");
  const linked=await report(out);assert.equal(linked.ok,false);assert.equal(linked.error.code,"INVALID_EVIDENCE");
  const other=await copy();await mkdir(path.join(other,".experiment.lock"));
  const blocked=await report(other);assert.equal(blocked.ok,false);assert.equal(blocked.error.code,"LOCK_BLOCKED");
});

test("CLI emits redacted JSON or escaped Markdown without writing or invoking a client",async()=>{
  const out=path.join(directory,randomUUID());
  await fixture(out,{repetitions:1,weak:"<img src=x>|API_KEY=private-model-canary\n![remote](https://example.invalid/image)"});
  const prior=await tree(out);
  const invoke=args=>spawnSync(process.execPath,[path.join(sourceRoot,"benchmarks/report.mjs"),"--out",out,...args],
    {shell:false,windowsHide:true,encoding:"utf8",timeout:15000,env:{...process.env,NODE_TEST_CONTEXT:undefined}});
  const result=invoke([]);assert.equal(result.status,0,result.stderr);
  const value=JSON.parse(result.stdout);assert.equal(value.ok,true);assert.equal(value.mode,"simulated");
  assert.ok(value.experiment.groups.find(group=>group.id==="weak-baseline").model.includes("[REDACTED]"));
  assert.doesNotMatch(result.stdout,/private-model-canary|private-answer-canary/);
  const formatted=invoke(["--format","markdown"]);assert.equal(formatted.status,0,formatted.stderr);
  assert.match(formatted.stdout,/模式：simulated；题集：project；客户端：codex；样本：2；配对：1/);
  assert.match(formatted.stdout,/&lt;img src=x&gt;/);
  assert.ok(formatted.stdout.includes("\\|"));
  assert.ok(formatted.stdout.includes("\\!\\[remote\\]\\(https://example.invalid/image\\)"));
  assert.match(formatted.stdout,/差值\(Harness−baseline\).*\| 10 \| 1 \| -20 \/ 10 \|/);
  assert.doesNotMatch(formatted.stdout,/private-model-canary|private-answer-canary|<img src=x>/);
  assert.equal(invoke(["--format","csv"]).status,1);
  assert.equal(invoke(["--format","markdown","--format","json"]).status,1);
  assert.deepEqual(await tree(out),prior);
});
