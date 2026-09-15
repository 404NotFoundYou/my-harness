import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { projectTasks } from "../project-tasks.mjs";
import { cleanupSandbox, createParticipant, gradeCandidate, hash, inspectChanges, participantPrompt, runCase } from "../runner.mjs";
import { experimentPlan, runExperiment } from "../experiment.mjs";
import { auditExperiment } from "../audit.mjs";
import { collectCandidate, validateCandidate } from "../candidates.mjs";
import { taskManifest } from "../task-contract.mjs";
import { beginWorkItem, finishWorkItem } from "../../.ai-harness/src/compact.mjs";
import { runRecordedCommand } from "../../.ai-harness/src/evidence.mjs";
import { checkProject } from "../../.ai-harness/src/checker.mjs";

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const task=projectTasks[0];
const group={id:"weak-baseline",model:"synthetic",harness:false};
const candidate = (files=task.reference) => ({schemaVersion:1,files:Object.fromEntries([...task.writableFiles].sort().map(file=>[file,Object.hasOwn(files,file)?{status:"present",content:files[file],sha256:hash(Buffer.from(files[file]))}:{status:"missing"}]))});
const synthetic = () => ({mode:"simulated",client:"codex",completed:true,final:{completed:true,summary:"synthetic fixture only",tests:["node --test test/public.test.mjs"]},durationMs:1,usage:null});
async function cleanup(root) {
  assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith("ai-harness-multifile-"));
  await rm(root,{recursive:true,force:true});
}

test("the project judge needs both repaired modules and preserves fixed callers and dependencies",async()=>{
  const complete=await gradeCandidate(task,candidate());
  assert.equal(complete.ok,true,JSON.stringify(complete));
  assert.equal(complete.cases.length,12);
  for(const file of task.writableFiles){
    assert.equal((await gradeCandidate(task,candidate({...task.reference,[file]:task.files[file]}))).ok,false,`${file} must be repaired`);
  }
  const missing=candidate({});
  const absent=await gradeCandidate(task,missing);
  assert.equal(absent.ok,false);
  assert.equal(absent.complete,false);
  assert.match(absent.error,/candidate/i);
  const overlay=candidate();
  overlay.files["src/caller.mjs"]={status:"present",content:"modified",sha256:hash("modified")};
  await assert.rejects(()=>gradeCandidate(task,overlay),/candidate/i);
});

test("candidate manifests reject ambiguous states and task paths cannot authorize read-only overlays",()=>{
  for(const file of ["../escape.mjs","/absolute.mjs","src/../escape.mjs","src\\other.mjs","src/drive:c.mjs","test/public.test.mjs"]){
    assert.throws(()=>taskManifest({...task,writableFiles:[file],files:{...task.files,[file]:""}}),/task/i);
  }
  assert.throws(()=>taskManifest({...task,writableFiles:[task.writableFiles[0],task.writableFiles[0]]}),/task/i);
  for(const malformed of [{status:"missing",content:"stale"},{status:"invalid",reason:"unknown"},{status:"present",content:"changed",sha256:hash("different")}]){
    const value=candidate();
    value.files[task.writableFiles[0]]=malformed;
    assert.throws(()=>validateCandidate(task,value),/candidate/i);
  }
});

test("candidate collection preserves BOM and CRLF bytes and does not hide unexpected IO errors",async(t)=>{
  const participant=await createParticipant(task,{sourceRoot,harness:false});
  const aliases=await mkdtemp(path.join(tmpdir(),"ai-harness-multifile-alias-"));
  const alias=path.join(aliases,"project");
  const file=path.join(alias,task.writableFiles[0]);
  const raw="\uFEFF"+task.reference[task.writableFiles[0]].replaceAll("\n","\r\n");
  try{
    await symlink(participant.root,alias,process.platform === "win32" ? "junction" : "dir");
    await writeFile(file,raw);
    const captured=await collectCandidate(alias,task);
    assert.equal(captured.files[task.writableFiles[0]].content,raw);
    assert.equal(captured.files[task.writableFiles[0]].sha256,hash(Buffer.from(raw)));
    const original=fsPromises.readFile;
    const canonicalFile=await realpath(file);
    t.mock.method(fsPromises,"readFile",async(target,...args)=>{
      if(await realpath(target)===canonicalFile)throw Object.assign(new Error("synthetic read denied"),{code:"EACCES"});
      return original(target,...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(()=>collectCandidate(alias,task),{code:"EACCES"});
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(aliases);await cleanupSandbox(participant.root);}
});

test("project selection is explicit and dry-run budgets preserve the default core experiment",async()=>{
  assert.equal(experimentPlan({weak:"w",strong:"s"}).schedule.length,9);
  const plan=experimentPlan({weak:"w",comparison:"paired",suite:"project"});
  assert.equal(plan.schemaVersion,3);
  assert.equal(plan.schedule.length,2);
  assert.equal(plan.suite,"project");
  assert.ok(plan.schedule.every(entry=>entry.taskId===task.id));
  assert.throws(()=>experimentPlan({weak:"w",strong:"s",suite:"unknown"}));
  const directory=await mkdtemp(path.join(tmpdir(),"ai-harness-multifile-dry-"));
  try{
    const result=spawnSync(process.execPath,[path.join(sourceRoot,"benchmarks/run.mjs"),"--cli","not-installed","--weak","synthetic","--comparison","paired","--suite","project","--out",path.join(directory,"unused"),"--dry-run"],{shell:false,windowsHide:true,encoding:"utf8",timeout:5000});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).modelCalls,2);
    assert.deepEqual(await readdir(directory),[]);
    const invalid=structuredClone(plan);
    invalid.schedule[0].taskId="unknown";
    await assert.rejects(()=>runExperiment({plan:invalid,sourceRoot,outputDirectory:path.join(directory,"rejected"),mode:"simulated",driver:async()=>assert.fail("must not start a driver")}),/plan/i);
    assert.deepEqual(await readdir(directory),[]);
  }finally{await cleanup(directory);}
});

test("only declared implementation files are writable and project prompts require BUGFIX",async()=>{
  const participant=await createParticipant(task,{sourceRoot,harness:true});
  try{
    assert.match(await readFile(path.join(participant.root,"AGENTS.md"),"utf8"),/BUGFIX/);
    assert.match(participantPrompt(task,{...group,harness:true}),/BUGFIX/);
    assert.doesNotMatch(participantPrompt(task,{...group,harness:true}),/普通ITERATION/);
    for(const [file,content]of Object.entries(task.reference))await writeFile(path.join(participant.root,file),content);
    assert.equal((await inspectChanges(participant,task,true)).ok,true);
    await writeFile(path.join(participant.root,"test/public.test.mjs"),"tampered");
    await writeFile(path.join(participant.root,"src/limits.mjs"),"tampered");
    const changed=await inspectChanges(participant,task,true);
    assert.equal(changed.ok,false);
    assert.ok(changed.violations.includes("test/public.test.mjs"));
    assert.ok(changed.violations.includes("src/limits.mjs"));
    assert.equal((await readdir(participant.root)).includes("benchmarks"),false);
    // The independent judge uses the frozen dependencies, not these tampered files.
    assert.equal((await gradeCandidate(task,await collectCandidate(participant.root,task))).ok,true);
  }finally{await cleanupSandbox(participant.root);}
});

test("collection fails on missing, non-file, invalid UTF-8 and parent junction candidates",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"ai-harness-multifile-invalid-"));
  try{
    for(const scenario of ["missing","directory","utf8","junction"]){
      const outputDirectory=path.join(directory,scenario);
      const result=await runCase({task,group,sourceRoot,outputDirectory,driver:async({root})=>{
        for(const [file,content]of Object.entries(task.reference))await writeFile(path.join(root,file),content);
        const file=path.join(root,task.writableFiles[0]);
        if(scenario==="missing")await rm(file);
        if(scenario==="directory"){await rm(file);await mkdir(file);}
        if(scenario==="utf8")await writeFile(file,Buffer.from([0xff,0xfe,0xfd]));
        if(scenario==="junction"){
          const linked=path.join(directory,"linked");
          await mkdir(linked);
          for(const relative of task.writableFiles)await writeFile(path.join(linked,path.basename(relative)),"unreadable candidate");
          await rm(path.join(root,"src"),{recursive:true,force:true});
          await symlink(linked,path.join(root,"src"),process.platform==="win32"?"junction":"dir");
        }
        return synthetic();
      }});
      assert.equal(result.success,false,scenario);
      assert.equal(result.scope.ok,false,scenario);
      assert.equal(result.grade.ok,false,scenario);
      assert.equal(result.grade.complete,false,scenario);
      const saved=JSON.parse(await readFile(path.join(outputDirectory,"candidate-files.json"),"utf8"));
      assert.notEqual(saved.files[task.writableFiles[0]].status,"present",scenario);
    }
  }finally{await cleanup(directory);}
});

test("passing code cannot substitute ITERATION or an unrelated BUGFIX for the project workflow",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"ai-harness-multifile-workflow-"));
  try{
    for(const scenario of ["wrong-type","unrelated-scope"]){
      const result=await runCase({task,group:{...group,id:"weak-harness",harness:true},sourceRoot,outputDirectory:path.join(directory,scenario),driver:async({root})=>{
        const type=scenario === "wrong-type" ? "ITERATION" : "BUGFIX";
        if(scenario === "unrelated-scope")for(const [file,content]of Object.entries(task.reference))await writeFile(path.join(root,file),content);
        await beginWorkItem(root,{id:"UNRELATED",type,title:"isolated negative workflow fixture",references:["TASK.md"],acceptance:["public tests pass"],authorizationMode:"autonomous",authorizationSource:"synthetic fixture",risk:"medium",approach:"exercise workflow classification",databaseEvidence:"in-memory fixture",writeScopes:scenario === "wrong-type" ? task.writableFiles : ["test/extra.test.mjs"],verification:["node --test test/public.test.mjs"],docsImpact:["N/A: fixture"],...(type === "BUGFIX" ? {bug:{actual:"fixture requires validation",expected:"public checks pass",reproduction:"node --test test/public.test.mjs"}} : {})});
        if(scenario === "wrong-type")for(const [file,content]of Object.entries(task.reference))await writeFile(path.join(root,file),content);
        const verified=await runRecordedCommand(root,{id:"UNRELATED",taskId:"T1",checkId:"V1"});
        assert.equal(verified.status,"pass");
        await finishWorkItem(root,"UNRELATED",{commandIds:[verified.id],verification:"public tests pass",review:"isolated workflow fixture reviewed",documentation:"N/A: fixture",acceptance:"public test result checked",...(type === "BUGFIX" ? {stageEvidence:["static=module parse checked by node test","sandbox=isolated temporary directory execution","reproduction=fixture public checks executed","regression=fixture public checks pass"],stageCommands:[`reproduction=${verified.id}`,`regression=${verified.id}`]} : {})});
        assert.equal((await checkProject(root,{ci:true})).ok,true);
        return synthetic();
      }});
      assert.equal(result.grade.ok,true,scenario);
      assert.equal(result.workflow.ok,false,scenario);
      assert.equal(result.workflow.contract.ok,false,scenario);
      assert.deepEqual(result.workflow.contract.uncoveredFiles,[...task.writableFiles].sort(),scenario);
      assert.equal(result.success,false,scenario);
      assert.equal(result.falseCompletion,true,scenario);
    }
  }finally{await cleanup(directory);}
});

test("a simulated project experiment completes real BUGFIX gates and audits every candidate file",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"ai-harness-multifile-experiment-"));
  try{
    const outputDirectory=path.join(directory,"run");
    const plan=experimentPlan({weak:"synthetic",comparison:"paired",suite:"project",timeoutMs:30000});
    let calls=0;
    const summary=await runExperiment({plan,sourceRoot,outputDirectory,mode:"simulated",driver:async({root,outputDirectory:output})=>{
      calls++;
      const harness=await readdir(root).then(files=>files.includes(".ai-harness"));
      if(harness)await beginWorkItem(root,{id:"PAGING",type:"BUGFIX",title:"repair pagination",references:["TASK.md"],acceptance:["public bug reproduction and pagination contract pass"],authorizationMode:"autonomous",authorizationSource:"isolated simulated experiment",risk:"medium",approach:"fix filtering before exclusive cursor paging",databaseEvidence:"in-memory records only",writeScopes:task.writableFiles,verification:["node --test test/public.test.mjs"],docsImpact:["N/A: preserve public contract"],bug:{actual:"archived records consume pages and cursor repeats",expected:"visible stable records with an exclusive cursor",reproduction:"node --test test/public.test.mjs"}});
      const before=harness?await runRecordedCommand(root,{id:"PAGING",taskId:"T1",checkId:"V1"}):spawnSync(process.execPath,["--test","test/public.test.mjs"],{cwd:root,shell:false,windowsHide:true,encoding:"utf8",env:{...process.env,NODE_TEST_CONTEXT:undefined}});
      assert.equal(harness?before.status==="fail":before.status!==0,true);
      for(const [file,content]of Object.entries(task.reference))await writeFile(path.join(root,file),content);
      if(harness){
        const verified=await runRecordedCommand(root,{id:"PAGING",taskId:"T1",checkId:"V1"});
        assert.equal(verified.status,"pass");
        const done=await finishWorkItem(root,"PAGING",{commandIds:[verified.id],verification:"public reproduction passed after both module repairs",review:"checked both modules and immutable caller",documentation:"N/A: preserve public contract",acceptance:"public behavior restored",stageEvidence:["static=module parsing and contracts checked","sandbox=isolated temporary repository test passed","reproduction=original public failure now passes","regression=existing public first-page contract also passes"],stageCommands:[`reproduction=${verified.id}`,`regression=${verified.id}`]});
        assert.equal(done.status,"DONE");
        assert.equal((await checkProject(root,{ci:true})).ok,true);
      }else{
        const after=spawnSync(process.execPath,["--test","test/public.test.mjs"],{cwd:root,shell:false,windowsHide:true,encoding:"utf8",env:{...process.env,NODE_TEST_CONTEXT:undefined}});
        assert.equal(after.status,0,after.stderr);
      }
      await writeFile(path.join(output,"events.jsonl"),'{"type":"synthetic"}\n');
      return synthetic();
    }});
    assert.equal(calls,2);
    assert.equal(summary.complete,true);
    assert.ok(summary.results.every(row=>row.success));
    const audited=await auditExperiment(outputDirectory);
    assert.equal(audited.samples,2);
    assert.equal(audited.mode,"simulated");
    const workflow=audited.rows.find(row=>row.group === "weak-harness").workflow;
    assert.equal(workflow.contract.ok,true);
    assert.equal(workflow.contract.requiredType,"BUGFIX");
    assert.deepEqual(workflow.contract.uncoveredFiles,[]);
    const harnessFolder=plan.schedule.find(entry=>entry.group === "weak-harness").directory;
    for(const [file,mutate] of [["state.json",value=>{value.type="ITERATION";}],["plan.json",value=>{value.tasks[0].writeScopes=["test/extra.test.mjs"];}]]){
      const archive=path.join(outputDirectory,harnessFolder,"work-items/PAGING",file);
      const original=await readFile(archive,"utf8");
      const changed=JSON.parse(original);
      mutate(changed);
      await writeFile(archive,JSON.stringify(changed));
      await assert.rejects(()=>auditExperiment(outputDirectory),/project workflow/);
      await writeFile(archive,original);
    }
    const protocolPath=path.join(outputDirectory,"protocol.json");
    const originalProtocol=await readFile(protocolPath,"utf8");
    const protocol=JSON.parse(originalProtocol);
    assert.deepEqual(protocol.tasks[0].writableFiles,[...task.writableFiles].sort());
    const candidatePath=path.join(outputDirectory,plan.schedule[0].directory,"candidate-files.json");
    const originalCandidate=await readFile(candidatePath,"utf8");
    const corrupted=JSON.parse(originalCandidate);
    corrupted.files[task.writableFiles[0]].content+="\n// tampered";
    await writeFile(candidatePath,JSON.stringify(corrupted));
    await assert.rejects(()=>auditExperiment(outputDirectory),/candidate/i);
    await writeFile(candidatePath,originalCandidate);
    protocol.tasks[0].writableFiles.push("src/limits.mjs");
    await writeFile(protocolPath,JSON.stringify(protocol));
    await assert.rejects(()=>auditExperiment(outputDirectory));
    await writeFile(protocolPath,originalProtocol);
    const summaryPath=path.join(outputDirectory,"summary.json");
    const savedSummary=JSON.parse(await readFile(summaryPath,"utf8"));
    savedSummary.results[0].success=false;
    await writeFile(summaryPath,JSON.stringify(savedSummary));
    await assert.rejects(()=>auditExperiment(outputDirectory));
    savedSummary.results[0].success=true;
    // Synthetic wire fixtures exercise the real-mode audit path without any model call.
    savedSummary.mode="real";
    const realProtocol=JSON.parse(originalProtocol);
    realProtocol.mode="real";
    await writeFile(protocolPath,JSON.stringify(realProtocol));
    await writeFile(summaryPath,JSON.stringify(savedSummary));
    for(const entry of plan.schedule){
      const folder=path.join(outputDirectory,entry.directory);
      const resultPath=path.join(folder,"result.json");
      const row=JSON.parse(await readFile(resultPath,"utf8"));
      row.mode="real";
      Object.assign(row.run,{mode:"real",exitCode:0,error:null,errors:[],warnings:[],unparsedLines:0,turnCompleted:true,protocolSuccess:true});
      await writeFile(resultPath,JSON.stringify(row));
      await writeFile(path.join(folder,"final.json"),JSON.stringify(row.run.final));
      await writeFile(path.join(folder,"events.jsonl"),'{"type":"turn.completed"}\n');
    }
    assert.equal((await auditExperiment(outputDirectory)).valid,true);
    await writeFile(path.join(outputDirectory,plan.schedule[0].directory,"events.jsonl"),"");
    await assert.rejects(()=>auditExperiment(outputDirectory),/raw protocol/);
  }finally{await cleanup(directory);}
});
