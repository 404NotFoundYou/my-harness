import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir, hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { cliIdentity, experimentPlan, runExperiment } from "../experiment.mjs";
import { hash } from "../runner.mjs";
import { projectTasks } from "../project-tasks.mjs";
import { withFileLock } from "../../.ai-harness/src/locking.mjs";
import { cleanup as cleanupSource, createInstalledProject } from "../../.ai-harness/tests/helpers.mjs";

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const identity={kind:"simulated",fingerprint:hash("status fixture")};
const inspect=async options=>(await import("../status.mjs")).inspectExperiment(options);
const json=async file=>JSON.parse(await readFile(file,"utf8"));
async function tree(root){
  const output={};
  async function walk(directory,prefix=""){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const relative=prefix+entry.name,absolute=path.join(directory,entry.name);
      if(entry.isSymbolicLink())output[relative]="link";
      else if(entry.isDirectory()){output[relative+"/"]="directory";await walk(absolute,relative+"/");}
      else output[relative]=hash(await readFile(absolute));
    }
  }
  await walk(root);return output;
}
async function cleanup(root){const target=await realpath(root);assert.equal(path.dirname(target),await realpath(tmpdir()));assert.ok(path.basename(target).startsWith("ai-harness-status-"));await rm(target,{recursive:true,force:true});}
async function fixture({stop="ready",source=sourceRoot,mode="simulated",weak="synthetic",repetitions=1}={}){
  const directory=await mkdtemp(path.join(tmpdir(),"ai-harness-status-")),outputDirectory=path.join(directory,"run");
  const cli=path.join(directory,"never-run.mjs");await writeFile(cli,'throw new Error("status must never execute this CLI");\n');
  const driverIdentity=mode === "real"?await cliIdentity(cli):identity;
  const options={plan:experimentPlan({weak,comparison:"paired",suite:"project",timeoutMs:5000,repetitions}),sourceRoot:source,outputDirectory,mode,driverIdentity};
  try{
    await runExperiment({...options,onProgress:event=>{if(event.event===stop)throw new Error("fixture pause");},driver:async({root,outputDirectory:out})=>{
      if(stop === "driver")throw new Error("fixture pause");
      for(const [file,content]of Object.entries(projectTasks[0].reference))await writeFile(path.join(root,file),content);
      await writeFile(path.join(out,"events.jsonl"),'{"type":"synthetic"}\n');
      return {mode,client:"codex",completed:true,final:{completed:true,summary:"fixture",tests:[]},durationMs:1,usage:null};
    }});
  }catch(error){if(!error.message.includes("fixture pause")){await cleanup(directory);throw error;}}
  return {directory,cli,options};
}
async function unchanged(t,root,action){
  const before=await tree(root);let writes=0;
  for(const name of ["writeFile","appendFile","mkdir","rename","rm","unlink","rmdir","copyFile"]){
    t.mock.method(fs,name,async()=>{writes++;throw new Error("status attempted a filesystem mutation");});
  }
  syncBuiltinESMExports();
  let result;
  try{result=await action();assert.equal(writes,0);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
  assert.deepEqual(await tree(root),before);return result;
}

test("pending preview validates evidence without fixing a corrupt derived summary",async(t)=>{
  const fx=await fixture();
  try{
    await writeFile(path.join(fx.options.outputDirectory,"summary.json"),"broken summary");
    const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(report.readOnly,true);
    assert.equal(report.integrity,"verified");
    assert.equal(report.observed.totals.pending,2);
    assert.equal(report.resume.canResume,true);
    assert.equal(report.resume.remainingCalls,2);
    assert.equal(report.resume.validationRequiredOnExecution,true);
    const unknown=await inspect({sourceRoot,outputDirectory:fx.options.outputDirectory});
    assert.equal(unknown.driver.status,"unverified");
    assert.equal(unknown.resume.canResume,false);
    assert.equal(unknown.resume.remainingCalls,null);
  }finally{await cleanup(fx.directory);}
});

test("stored started trials are distinct from projected recovery and are never rewritten",async(t)=>{
  for(const stop of ["finished","driver"]){
    const fx=await fixture({stop});
    try{
      const file=path.join(fx.options.outputDirectory,"execution.json"),ledger=await json(file);
      ledger.trials[0].status="started";delete ledger.trials[0].resultSha256;delete ledger.trials[0].reason;
      await writeFile(file,JSON.stringify(ledger));
      const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
      assert.equal(report.observed.totals.started,1);
      assert.equal(report.recoveryPreview.totals[stop === "finished"?"completed":"interrupted"],1);
      assert.equal(report.recoveryPreview.needed,true);
      assert.equal(report.resume.remainingCalls,1);
      assert.equal((await json(file)).trials[0].status,"started");
    }finally{await cleanup(fx.directory);}
  }
});

test("an active writer leaves started observations unverified and blocks readiness",async(t)=>{
  const fx=await fixture({stop:"driver"});
  try{
    const file=path.join(fx.options.outputDirectory,"execution.json"),ledger=await json(file);
    ledger.trials[0].status="started";delete ledger.trials[0].reason;await writeFile(file,JSON.stringify(ledger));
    await withFileLock(path.join(fx.options.outputDirectory,".experiment.lock"),async()=>{
      const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
      assert.equal(report.lock.status,"active");
      assert.equal(report.observed.totals.started,1);
      assert.equal(report.integrity,"unverified");
      assert.equal(report.recoveryPreview,null);
      assert.equal(report.resume.canResume,false);
      assert.equal(report.resume.remainingCalls,null);
    });
  }finally{await cleanup(fx.directory);}
});

test("a dead owner is inspected without reclaiming its lock",async(t)=>{
  const fx=await fixture();
  try{
    const script=path.join(fx.directory,"lock.mjs"),moduleUrl=pathToFileURL(path.join(sourceRoot,".ai-harness/src/locking.mjs")).href;
    await writeFile(script,`import {withFileLock} from ${JSON.stringify(moduleUrl)};await withFileLock(${JSON.stringify(path.join(fx.options.outputDirectory,".experiment.lock"))},()=>process.exit(73));`);
    const child=spawnSync(process.execPath,[script],{shell:false,windowsHide:true,encoding:"utf8",timeout:5000,env:{...process.env,NODE_TEST_CONTEXT:undefined}});
    assert.equal(child.status,73,child.stderr);
    const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(report.lock.status,"stale");
    assert.equal(report.resume.lockRecoveryRequired,true);
    assert.equal(report.resume.canResume,true);
  }finally{await cleanup(fx.directory);}
});

test("source and explicit identity drift block preview without changing trusted records",async(t)=>{
  const source=await createInstalledProject(),fx=await fixture({source});
  try{
    await writeFile(path.join(source,"drift.txt"),"changed");
    const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:{kind:"simulated",fingerprint:hash("different")}}));
    assert.equal(report.source.status,"mismatch");assert.equal(report.driver.status,"mismatch");
    assert.equal(report.resume.canResume,false);assert.equal(report.resume.remainingCalls,null);
    assert.ok(report.blockers.some(row=>row.code==="SOURCE_MISMATCH"));
  }finally{await cleanup(fx.directory);await cleanupSource(source);}
});

test("corrupt or linked evidence is rejected without repairs or raw candidate content in diagnostics",async(t)=>{
  const fx=await fixture({stop:"finished"});
  try{
    const protocol=await json(path.join(fx.options.outputDirectory,"protocol.json"));
    const result=path.join(fx.options.outputDirectory,protocol.schedule[0].directory,"result.json");
    await writeFile(result,"private-fixture-content");
    const broken=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(broken.integrity,"invalid");assert.equal(broken.resume.remainingCalls,null);
    assert.doesNotMatch(JSON.stringify(broken),/private-fixture-content/);
    const moved=path.join(fx.directory,"linked");await mkdir(moved);await writeFile(path.join(moved,"result.json"),"{}");
    await rm(path.dirname(result),{recursive:true,force:true});
    await symlink(moved,path.dirname(result),process.platform === "win32"?"junction":"dir");
    const linked=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(linked.integrity,"invalid");assert.equal(linked.resume.canResume,false);
  }finally{await cleanup(fx.directory);}
});

test("observations changed during evidence reading revoke readiness instead of claiming corruption",async(t)=>{
  const fx=await fixture();
  try{
    const file=path.join(fx.options.outputDirectory,"execution.json"),original=fs.readFile;let changed=false;
    t.mock.method(fs,"readFile",async(target,...args)=>{
      const bytes=await original(target,...args);
      if(!changed&&path.basename(String(target))==="execution.json"){
        changed=true;const ledger=JSON.parse(bytes.toString("utf8"));ledger.trials[0]={...ledger.trials[0],status:"started",startedAt:new Date().toISOString()};
        await writeFile(file,JSON.stringify(ledger));
      }
      return bytes;
    });syncBuiltinESMExports();
    const report=await inspect({...fx.options,driverIdentity:identity});
    assert.equal(report.observation.stable,false);
    assert.ok(report.blockers.some(row=>row.code==="CONCURRENT_CHANGE"));
    assert.equal(report.integrity,"unverified");assert.equal(report.resume.canResume,false);assert.equal(report.resume.remainingCalls,null);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.directory);}
});

test("a lock acquired while reading is reported as a changed observation",async(t)=>{
  const fx=await fixture();
  try{
    const original=fs.readFile;let changed=false;
    t.mock.method(fs,"readFile",async(target,...args)=>{
      const bytes=await original(target,...args);
      if(!changed&&path.basename(String(target))==="execution.json"){
        changed=true;const token=randomUUID(),lock=path.join(fx.options.outputDirectory,".experiment.lock");
        await mkdir(lock);await writeFile(path.join(lock,`owner-${token}.json`),JSON.stringify({version:2,pid:process.pid,hostname:hostname(),token,createdAt:new Date().toISOString()}));
      }
      return bytes;
    });syncBuiltinESMExports();
    const report=await inspect({...fx.options,driverIdentity:identity});
    assert.equal(report.observation.stable,false);assert.equal(report.resume.remainingCalls,null);
    assert.ok(report.blockers.some(row=>row.code==="CONCURRENT_CHANGE"));
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.directory);}
});

test("CLI preview needs no installed client unless explicitly checking its identity",async(t)=>{
  const fx=await fixture({mode:"real"});
  try{
    const original=fs.readFile,canonical=await realpath(fx.cli);let cliReads=0;
    t.mock.method(fs,"readFile",async(target,...args)=>{
      const actual=await realpath(target).catch(()=>null);
      if(actual===canonical){cliReads++;throw new Error("protocol must not choose an external file to read");}
      return original(target,...args);
    });syncBuiltinESMExports();
    const unknown=await inspect({sourceRoot,outputDirectory:fx.options.outputDirectory});
    assert.equal(cliReads,0);assert.equal(unknown.driver.status,"unverified");
    t.mock.restoreAll();syncBuiltinESMExports();
    const before=await tree(fx.options.outputDirectory);
    const run=args=>spawnSync(process.execPath,[path.join(sourceRoot,"benchmarks/status.mjs"),"--out",fx.options.outputDirectory,...args],{shell:false,windowsHide:true,encoding:"utf8",timeout:15000,env:{...process.env,NODE_TEST_CONTEXT:undefined}});
    assert.equal(run([]).status,2);
    const checked=run(["--cli",fx.cli]);assert.equal(checked.status,0,checked.stderr);
    assert.equal(JSON.parse(checked.stdout).resume.remainingCalls,2);
    await writeFile(fx.cli,"// changed\n");
    assert.equal(run(["--cli",fx.cli]).status,2);
    assert.deepEqual(await tree(fx.options.outputDirectory),before);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.directory);}
});

test("historical protocols stay unsupported and no pending calls is not completion",async(t)=>{
  const fx=await fixture({stop:"driver"});
  try{
    // Mark the untouched second slot as interrupted in this isolated fixture.
    const file=path.join(fx.options.outputDirectory,"execution.json"),ledger=await json(file);
    ledger.trials[1]={...ledger.trials[1],status:"interrupted",startedAt:new Date().toISOString(),reason:"result-unavailable"};
    await writeFile(file,JSON.stringify(ledger));
    const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(report.resume.remainingCalls,0);assert.equal(report.recoveryPreview.complete,false);
    const protocolFile=path.join(fx.options.outputDirectory,"protocol.json"),protocol=await json(protocolFile);protocol.schemaVersion=3;
    await writeFile(protocolFile,JSON.stringify(protocol));
    const legacy=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(legacy.integrity,"unsupported");assert.equal(legacy.resume.canResume,false);assert.equal(legacy.resume.remainingCalls,null);
  }finally{await cleanup(fx.directory);}
});

test("source and explicit CLI changes during inspection revoke earlier identity matches",async(t)=>{
  for(const subject of ["source","driver"]){
    const source=await createInstalledProject(),fx=await fixture({source,mode:"real"});
    try{
      const original=fs.readFile;let reads=0;
      t.mock.method(fs,"readFile",async(target,...args)=>{
        const bytes=await original(target,...args);
        if(path.basename(String(target))==="execution.json"&&++reads===2)await writeFile(subject==="source"?path.join(source,"changed.txt"):fx.cli,"changed during inspection");
        return bytes;
      });syncBuiltinESMExports();
      const report=await inspect({sourceRoot:source,outputDirectory:fx.options.outputDirectory,cliPath:fx.cli});
      assert.equal(report[subject].status,"unverified");assert.equal(report.observation.stable,false);
      assert.equal(report.resume.canResume,false);assert.equal(report.resume.remainingCalls,null);
      assert.ok(report.blockers.some(row=>row.code===(subject==="source"?"SOURCE_CHANGED":"DRIVER_CHANGED")));
    }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.directory);await cleanupSource(source);}
  }
});

test("failed evidence reads still detect a concurrent writer and do not label records corrupt",async(t)=>{
  const fx=await fixture({stop:"finished"});
  try{
    const ledgerFile=path.join(fx.options.outputDirectory,"execution.json"),ledger=await json(ledgerFile);
    const original=fs.readFile;let changed=false;
    t.mock.method(fs,"readFile",async(target,...args)=>{
      const bytes=await original(target,...args);
      if(!changed&&path.basename(String(target))==="result.json"){
        changed=true;ledger.trials[0].status="started";delete ledger.trials[0].resultSha256;
        await writeFile(ledgerFile,JSON.stringify(ledger));return Buffer.from("private-failed-read");
      }
      return bytes;
    });syncBuiltinESMExports();
    const report=await inspect({...fx.options,driverIdentity:identity});
    assert.equal(report.integrity,"unverified");assert.equal(report.observation.stable,false);
    assert.equal(report.recoveryPreview,null);assert.equal(report.resume.remainingCalls,null);
    assert.ok(report.blockers.some(row=>row.code==="CONCURRENT_CHANGE"));
    assert.ok(report.blockers.every(row=>row.code!=="INVALID_EVIDENCE"));
    assert.doesNotMatch(JSON.stringify(report),/private-failed-read/);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.directory);}
});

test("foreign, unknown and legacy locks cannot trigger result reads or recovery projections",async(t)=>{
  const fx=await fixture({stop:"finished"});
  try{
    const lock=path.join(fx.options.outputDirectory,".experiment.lock");
    for(const status of ["foreign","unknown","legacy"]){
      if(status==="legacy")await writeFile(lock,"legacy lock");
      else{
        await mkdir(lock);
        if(status==="foreign"){
          const token=randomUUID();
          await writeFile(path.join(lock,`owner-${token}.json`),JSON.stringify({version:2,pid:process.pid,hostname:hostname()+"-foreign",token,createdAt:new Date().toISOString()}));
        }
      }
      const original=fs.readFile;let resultReads=0;
      t.mock.method(fs,"readFile",async(target,...args)=>{
        if(path.basename(String(target))==="result.json"){resultReads++;throw new Error("must not audit a writer's results");}
        return original(target,...args);
      });syncBuiltinESMExports();
      const report=await inspect({...fx.options,driverIdentity:identity});
      assert.equal(resultReads,0);assert.equal(report.lock.status,status);assert.equal(report.integrity,"unverified");
      assert.equal(report.recoveryPreview,null);assert.equal(report.resume.remainingCalls,null);
      t.mock.restoreAll();syncBuiltinESMExports();await rm(lock,{recursive:status!=="legacy"});
    }
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.directory);}
});

test("status uses strict frozen protocol and ledger checks before offering any calls",async(t)=>{
  const fx=await fixture();
  try{
    const protocolFile=path.join(fx.options.outputDirectory,"protocol.json"),ledgerFile=path.join(fx.options.outputDirectory,"execution.json");
    const protocolBytes=await readFile(protocolFile),ledgerBytes=await readFile(ledgerFile);
    for(const defect of ["protocol","hash","ledger","pending-output"]){
      const protocol=JSON.parse(protocolBytes),ledger=JSON.parse(ledgerBytes);
      if(defect==="protocol"){protocol.tasks[0].taskDigest=hash("wrong task");await writeFile(protocolFile,JSON.stringify(protocol));ledger.protocolSha256=hash(await readFile(protocolFile));}
      if(defect==="hash")ledger.protocolSha256=hash("wrong protocol");
      if(defect==="ledger")ledger.trials[0].status="unknown";
      if(defect==="pending-output")await mkdir(path.join(fx.options.outputDirectory,ledger.trials[0].directory));
      await writeFile(ledgerFile,JSON.stringify(ledger));
      const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
      assert.equal(report.integrity,"invalid",defect);assert.equal(report.resume.canResume,false);assert.equal(report.resume.remainingCalls,null);
      await writeFile(protocolFile,protocolBytes);await writeFile(ledgerFile,ledgerBytes);
    }
    const missing=path.join(fx.directory,"absent");
    const command=spawnSync(process.execPath,[path.join(sourceRoot,"benchmarks/status.mjs"),"--out",missing],{shell:false,windowsHide:true,encoding:"utf8",timeout:15000});
    assert.equal(command.status,1);assert.equal(JSON.parse(command.stdout).integrity,"invalid");
    assert.ok(!(await readdir(fx.directory)).includes("absent"));
  }finally{await cleanup(fx.directory);}
});

test("large previews keep exact totals, bounded lists and redacted user fields without a summary",async(t)=>{
  const fx=await fixture({repetitions:11});
  try{
    const protocolFile=path.join(fx.options.outputDirectory,"protocol.json"),ledgerFile=path.join(fx.options.outputDirectory,"execution.json");
    const protocol=await json(protocolFile),ledger=await json(ledgerFile);
    for(const group of protocol.groups)group.model="API_KEY=status-secret-canary";
    await writeFile(protocolFile,JSON.stringify(protocol));ledger.protocolSha256=hash(await readFile(protocolFile));
    await writeFile(ledgerFile,JSON.stringify(ledger));await rm(path.join(fx.options.outputDirectory,"summary.json"));
    const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(report.resume.remainingCalls,22);assert.equal(report.observed.totals.pending,22);
    assert.equal(report.observed.trials.length,20);assert.equal(report.observed.omittedTrials,2);
    assert.equal(report.recoveryPreview.trials.length,20);assert.equal(report.recoveryPreview.omittedTrials,2);
    assert.doesNotMatch(JSON.stringify(report),/status-secret-canary/);
    assert.ok(report.protocol.groups.every(group=>group.model.includes("[REDACTED]")));
  }finally{await cleanup(fx.directory);}
});

test("all trusted results report completion independently of model task success",async(t)=>{
  const fx=await fixture({stop:"none"});
  try{
    const report=await unchanged(t,fx.options.outputDirectory,()=>inspect({...fx.options,driverIdentity:identity}));
    assert.equal(report.observed.totals.completed,2);assert.equal(report.recoveryPreview.complete,true);
    assert.equal(report.recoveryPreview.needed,false);assert.equal(report.resume.remainingCalls,0);
    const summary=await json(path.join(fx.options.outputDirectory,"summary.json"));
    assert.ok(summary.results.some(row=>!row.success));
  }finally{await cleanup(fx.directory);}
});
