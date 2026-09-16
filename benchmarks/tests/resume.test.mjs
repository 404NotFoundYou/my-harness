import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { cliIdentity, experimentPlan, runExperiment } from "../experiment.mjs";
import { auditExperiment } from "../audit.mjs";
import { projectTasks } from "../project-tasks.mjs";
import { hash, saveJson } from "../runner.mjs";
import { cleanup as cleanupSource, createInstalledProject } from "../../.ai-harness/tests/helpers.mjs";

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const identity={kind:"simulated",fingerprint:hash("resume fixture v1")};
const plan=()=>experimentPlan({weak:"synthetic",comparison:"paired",suite:"project",timeoutMs:5000});
const read=async(root,file)=>JSON.parse(await readFile(path.join(root,file),"utf8"));
async function fixture(){return mkdtemp(path.join(tmpdir(),"ai-harness-resume-"));}
async function cleanup(root){assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith("ai-harness-resume-"));await rm(root,{recursive:true,force:true});}
async function fakeDriver({root,outputDirectory}){
  for(const [file,content]of Object.entries(projectTasks[0].reference))await writeFile(path.join(root,file),content);
  await writeFile(path.join(outputDirectory,"events.jsonl"),'{"type":"synthetic"}\n');
  return {mode:"simulated",client:"codex",completed:true,final:{completed:true,summary:"fixture only",tests:[]},durationMs:1,usage:null};
}
const options=directory=>({plan:plan(),sourceRoot,outputDirectory:path.join(directory,"run"),mode:"simulated",driverIdentity:identity});

test("completed trials including failed deliveries are audited and never called again",async()=>{
  const directory=await fixture();let calls=0;
  const driver=async input=>{calls++;return fakeDriver(input);};
  try{
    const opts={...options(directory),driver};
    const initial=await runExperiment(opts);
    assert.equal((await read(opts.outputDirectory,"protocol.json")).schemaVersion,4);
    assert.equal(initial.complete,true);
    assert.ok(initial.results.some(row=>!row.success));
    const final=await runExperiment({...opts,resume:true});
    assert.equal(calls,2);
    assert.equal(final.complete,true);
    assert.ok(final.progress.every(group=>group.scheduled===1&&group.completed===1&&group.pending===0));
    assert.equal((await auditExperiment(opts.outputDirectory)).samples,2);
  }finally{await cleanup(directory);}
});

test("a stopped driver stays interrupted while resume runs only untouched trials",async()=>{
  const directory=await fixture();let calls=0;
  const driver=async input=>{if(++calls===1)throw new Error("synthetic interruption");return fakeDriver(input);};
  try{
    const opts={...options(directory),driver};
    await assert.rejects(()=>runExperiment(opts),/synthetic interruption/);
    const initial=await read(opts.outputDirectory,"summary.json");
    assert.equal(initial.notRun.length,1);
    assert.equal(initial.interrupted.length,1);
    const final=await runExperiment({...opts,resume:true});
    assert.equal(calls,2);
    assert.equal(final.complete,false);
    assert.deepEqual(final.notRun,[]);
    assert.equal(final.interrupted.length,1);
    assert.equal(final.progress.reduce((sum,row)=>sum+row.interrupted,0),1);
    assert.equal(final.progress.reduce((sum,row)=>sum+row.usageUnknown,0),2);
    await runExperiment({...opts,resume:true});
    assert.equal(calls,2);
    await assert.rejects(()=>auditExperiment(opts.outputDirectory),/incomplete/);
  }finally{await cleanup(directory);}
});

test("callbacks cannot change approved models or budgets by mutating caller-owned objects",async()=>{
  const directory=await fixture();const suppliedPlan=plan(),observed=[];
  try{
    const result=await runExperiment({...options(directory),plan:suppliedPlan,onProgress:event=>{
      if(event.event === "ready"){
        for(const group of suppliedPlan.groups)group.model="changed-after-freeze";
        suppliedPlan.budget.timeoutMs=60000;
        suppliedPlan.schedule.reverse();
      }
    },driver:async input=>{
      observed.push({model:input.model,timeoutMs:input.budget.timeoutMs});
      input.budget.timeoutMs=1;
      return fakeDriver(input);
    }});
    assert.equal(result.complete,true);
    assert.deepEqual(observed,[{model:"synthetic",timeoutMs:5000},{model:"synthetic",timeoutMs:5000}]);
    const protocol=await read(path.join(directory,"run"),"protocol.json");
    assert.ok(protocol.groups.every(group=>group.model === "synthetic"));
    assert.equal(protocol.budget.timeoutMs,5000);
    assert.equal((await auditExperiment(path.join(directory,"run"))).valid,true);
  }finally{await cleanup(directory);}
});

test("a stop before the first claim and a lost summary can be resumed without new identities",async()=>{
  const directory=await fixture();let calls=0;
  const driver=async input=>{calls++;return fakeDriver(input);};
  try{
    const opts={...options(directory),driver};
    await assert.rejects(()=>runExperiment({...opts,onProgress:event=>{if(event.event==="ready")throw new Error("stop before claim");}}),/stop before claim/);
    assert.equal(calls,0);
    assert.equal((await read(opts.outputDirectory,"summary.json")).notRun.length,2);
    await runExperiment({...opts,resume:true});
    await writeFile(path.join(opts.outputDirectory,"summary.json"),"half-written");
    assert.equal((await runExperiment({...opts,resume:true})).complete,true);
    assert.equal(calls,2);
  }finally{await cleanup(directory);}
});

test("resume validates the entire stored experiment before spending any pending call",async()=>{
  const directory=await fixture();let calls=0;
  const driver=async input=>{calls++;return fakeDriver(input);};
  try{
    const opts={...options(directory),driver};
    await assert.rejects(()=>runExperiment({...opts,onProgress:event=>{if(event.event==="finished")throw new Error("stop after result");}}),/stop after result/);
    assert.equal(calls,1);
    await assert.rejects(()=>runExperiment({...opts,resume:true,plan:experimentPlan({weak:"different",comparison:"paired",suite:"project",timeoutMs:5000})}));
    await assert.rejects(()=>runExperiment({...opts,resume:true,driverIdentity:{kind:"simulated",fingerprint:hash("other")}}));
    const protocol=await read(opts.outputDirectory,"protocol.json");
    const completed=protocol.schedule[0],pending=protocol.schedule[1];
    const resultPath=path.join(opts.outputDirectory,completed.directory,"result.json");
    const original=await readFile(resultPath);
    await writeFile(resultPath,"broken");
    await assert.rejects(()=>runExperiment({...opts,resume:true}));
    assert.equal(calls,1);
    await writeFile(resultPath,original);
    const ledgerPath=path.join(opts.outputDirectory,"execution.json"),ledgerBytes=await readFile(ledgerPath);
    const ledger=JSON.parse(ledgerBytes.toString("utf8"));
    ledger.trials[0].status="started";
    delete ledger.trials[0].resultSha256;
    await writeFile(ledgerPath,JSON.stringify(ledger));
    await writeFile(resultPath,"broken started result");
    await assert.rejects(()=>runExperiment({...opts,resume:true}));
    assert.equal(calls,1);
    await writeFile(resultPath,original);
    ledger.trials.push({...ledger.trials[0]});
    await writeFile(ledgerPath,JSON.stringify(ledger));
    await assert.rejects(()=>runExperiment({...opts,resume:true}),/schedule/);
    await writeFile(ledgerPath,ledgerBytes);
    await rm(resultPath);
    await assert.rejects(()=>runExperiment({...opts,resume:true}),/missing/);
    await writeFile(resultPath,original);
    await mkdir(path.join(opts.outputDirectory,pending.directory));
    await assert.rejects(()=>runExperiment({...opts,resume:true}),/pending/i);
    assert.equal(calls,1);
  }finally{await cleanup(directory);}
});

test("concurrent resume is refused while the existing driver owns the experiment",async()=>{
  const directory=await fixture();let calls=0,signal,release;
  const started=new Promise(resolve=>{signal=resolve;});
  const barrier=new Promise(resolve=>{release=resolve;});
  const driver=async input=>{if(++calls===1){signal();await barrier;}return fakeDriver(input);};
  const opts={...options(directory),driver};
  const running=runExperiment(opts);
  try{
    await started;
    await assert.rejects(()=>runExperiment({...opts,resume:true}),{code:"LOCK_TIMEOUT"});
    assert.equal(calls,1);
  }finally{release();await running;await cleanup(directory);}
});

test("source drift is rejected before resume can launch another trial",async()=>{
  const directory=await fixture();const source=await createInstalledProject();let calls=0;
  const driver=async input=>{calls++;return fakeDriver(input);};
  try{
    const opts={...options(directory),sourceRoot:source,driver};
    await assert.rejects(()=>runExperiment({...opts,onProgress:event=>{if(event.event==="finished")throw new Error("pause");}}),/pause/);
    await writeFile(path.join(source,"drift.txt"),"changed");
    await assert.rejects(()=>runExperiment({...opts,resume:true}),/source|protocol/i);
    assert.equal(calls,1);
  }finally{await cleanup(directory);await cleanupSource(source);}
});

test("source changes during a call cannot become trusted completed evidence",async()=>{
  const directory=await fixture(),source=await createInstalledProject();let calls=0;
  const driver=async input=>{calls++;const row=await fakeDriver(input);await writeFile(path.join(source,"drift.txt"),"changed during call");return row;};
  try{
    const opts={...options(directory),sourceRoot:source,driver};
    await assert.rejects(()=>runExperiment(opts),/source/i);
    const ledger=await read(opts.outputDirectory,"execution.json");
    assert.equal(ledger.trials[0].status,"interrupted");
    await rm(path.join(source,"drift.txt"));
    const resumed=await runExperiment({...opts,resume:true,driver:async()=>{throw new Error("remaining trial remains a separate interruption");}}).catch(error=>error);
    assert.match(resumed.message,/remaining trial/);
    assert.equal(calls,1);
  }finally{await cleanup(directory);await cleanupSource(source);}
});

test("a changed CLI identity cannot publish a reusable result even if its entry is restored",async()=>{
  const directory=await fixture();let calls=0;
  try{
    const entry=path.join(directory,"synthetic-cli.mjs"),original="// synthetic identity only; not executed\n";
    await writeFile(entry,original);
    const approved=await cliIdentity(entry),opts={...options(directory),mode:"real",driverIdentity:approved};
    const driver=async input=>{
      calls++;const row=await fakeDriver(input);
      await writeFile(path.join(input.outputDirectory,"events.jsonl"),'{"type":"turn.completed"}\n');
      await writeFile(path.join(input.outputDirectory,"final.json"),JSON.stringify(row.final));
      if(calls===1)await writeFile(entry,"// changed during a synthetic call\n");
      return {...row,mode:"real",exitCode:0,error:null,errors:[],warnings:[],unparsedLines:0,turnCompleted:true,protocolSuccess:true};
    };
    await assert.rejects(()=>runExperiment({...opts,driver}),/CLI identity changed/);
    const state=await read(opts.outputDirectory,"execution.json");
    assert.equal(state.trials[0].status,"interrupted");
    await assert.rejects(()=>readFile(path.join(opts.outputDirectory,opts.plan.schedule[0].directory,"result.json")),{code:"ENOENT"});
    await writeFile(entry,original);
    const resumed=await runExperiment({...opts,resume:true,driver});
    assert.equal(calls,2);
    assert.equal(resumed.complete,false);
    assert.equal(resumed.interrupted.length,1);
  }finally{await cleanup(directory);}
});

test("historical or partially initialized experiments and linked evidence are never resumed",async()=>{
  const directory=await fixture();let calls=0;
  const driver=async input=>{calls++;return fakeDriver(input);};
  try{
    const opts={...options(directory),driver};
    await assert.rejects(()=>runExperiment({...opts,onProgress:event=>{if(event.event==="ready")throw new Error("pause");}}),/pause/);
    const protocolPath=path.join(opts.outputDirectory,"protocol.json"),original=await readFile(protocolPath);
    const legacy=JSON.parse(original.toString("utf8"));legacy.schemaVersion=3;
    await writeFile(protocolPath,JSON.stringify(legacy));
    await assert.rejects(()=>runExperiment({...opts,resume:true}),/Only protocol v4/);
    await writeFile(protocolPath,original);
    const ledgerPath=path.join(opts.outputDirectory,"execution.json"),ledger=await readFile(ledgerPath);
    await rm(ledgerPath);
    await assert.rejects(()=>runExperiment({...opts,resume:true}));
    await writeFile(ledgerPath,ledger);
    const moved=path.join(directory,"evidence");
    await mkdir(moved);
    await writeFile(path.join(moved,"result.json"),"{}");
    const trial=path.join(opts.outputDirectory,opts.plan.schedule[0].directory);
    await symlink(moved,trial,process.platform === "win32"?"junction":"dir");
    await assert.rejects(()=>runExperiment({...opts,resume:true}),/链接|联接|symlink/i);
    assert.equal(calls,0);
  }finally{await cleanup(directory);}
});

test("atomic JSON publication preserves the old record when replacement fails",async(t)=>{
  const directory=await fixture(),file=path.join(directory,"record.json");
  try{
    await saveJson(file,{value:"before"});const original=await readFile(file);
    const rename=fsPromises.rename;
    t.mock.method(fsPromises,"rename",async(from,to)=>{if(path.resolve(to)===path.resolve(file))throw Object.assign(new Error("synthetic publish failure"),{code:"EIO"});return rename(from,to);});
    syncBuiltinESMExports();
    await assert.rejects(()=>saveJson(file,{value:"after"}),{code:"EIO"});
    assert.deepEqual(await readFile(file),original);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(directory);}
});

test("a process crash after result publication recovers its dead lock and reuses the result",async()=>{
  const directory=await fixture();let participant=null;
  try{
    const opts=options(directory),script=path.join(directory,"crash.mjs");
    const experimentUrl=pathToFileURL(path.join(sourceRoot,"benchmarks/experiment.mjs")).href;
    const taskUrl=pathToFileURL(path.join(sourceRoot,"benchmarks/project-tasks.mjs")).href;
    await writeFile(script,`import fs from "node:fs/promises";import path from "node:path";import {syncBuiltinESMExports} from "node:module";import {runExperiment} from ${JSON.stringify(experimentUrl)};import {projectTasks} from ${JSON.stringify(taskUrl)};
const rename=fs.rename;fs.rename=async(from,to)=>{await rename(from,to);if(path.basename(to)==="result.json")process.exit(73);};syncBuiltinESMExports();
await runExperiment({...${JSON.stringify(opts)},driver:async({root,outputDirectory})=>{await fs.writeFile(${JSON.stringify(path.join(directory,"participant.txt"))},root);for(const [file,content]of Object.entries(projectTasks[0].reference))await fs.writeFile(path.join(root,file),content);await fs.writeFile(path.join(outputDirectory,"events.jsonl"),'{"type":"synthetic"}\\n');return {mode:"simulated",client:"codex",completed:true,final:{completed:true,summary:"fixture only",tests:[]},durationMs:1,usage:null};}});`);
    const child=spawnSync(process.execPath,[script],{shell:false,windowsHide:true,encoding:"utf8",timeout:30000,env:{...process.env,NODE_TEST_CONTEXT:undefined}});
    assert.equal(child.status,73,child.stderr);
    participant=await realpath(await readFile(path.join(directory,"participant.txt"),"utf8"));
    let calls=0;
    const final=await runExperiment({...opts,resume:true,driver:async input=>{calls++;return fakeDriver(input);}});
    assert.equal(calls,1);
    assert.equal(final.complete,true);
    assert.equal((await auditExperiment(opts.outputDirectory)).samples,2);
  }finally{
    if(participant){assert.equal(path.dirname(participant),await realpath(tmpdir()));assert.ok(path.basename(participant).startsWith("ai-harness-bench-"));await rm(participant,{recursive:true,force:true});}
    await cleanup(directory);
  }
});

test("resume cannot be combined with a fresh-plan dry-run",()=>{
  const result=spawnSync(process.execPath,[path.join(sourceRoot,"benchmarks/run.mjs"),"--cli","not-installed","--weak","fixture","--out","unused","--resume","--dry-run"],{shell:false,windowsHide:true,encoding:"utf8",timeout:5000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/resume.*dry-run/i);
});
