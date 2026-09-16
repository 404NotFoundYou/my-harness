import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { installationFiles, installRuntime, initializeProject } from "../../src/installer.mjs";
import { getGitBaseline } from "../../src/git.mjs";
import { sourceSnapshot } from "../../src/snapshot.mjs";
import { beginWorkItem, finishWorkItem } from "../../src/compact.mjs";
import { runRecordedCommand } from "../../src/evidence.mjs";
import { checkProject } from "../../src/checker.mjs";
import { sourceRoot, git } from "../../tests/helpers.mjs";
import { experimentPlan, runExperiment } from "../../../benchmarks/experiment.mjs";
import { readExecution } from "../../../benchmarks/execution.mjs";
import { projectTasks } from "../../../benchmarks/project-tasks.mjs";

const rounds=5;
test("profile fixed isolated workflows without relaxing their completion gates",async(t)=>{
  const samples=[];let active=null;
  const spawn=childProcess.spawnSync;
  t.mock.method(childProcess,"spawnSync",(command,args,...rest)=>{
    const started=performance.now();
    try{return spawn(command,args,...rest);}finally{
      if(active&&path.basename(command).toLowerCase().replace(/\.exe$/,"")==="git"){
        const key=args[0]+(args.includes("--cached")?" --cached":args.includes("--others")?" --others":"");
        const row=active.git[key]??={calls:0,ms:0};row.calls++;row.ms+=performance.now()-started;
      }
    }
  });
  for(const name of ["readdir","readFile","writeFile","realpath","stat","lstat","mkdir","rename"]){
    const original=fs[name];
    t.mock.method(fs,name,async(...args)=>{
      const observed=active,started=performance.now();
      try{return await original(...args);}finally{if(observed){observed.fsCalls++;observed.fsMs+=performance.now()-started;}}
    });
  }
  syncBuiltinESMExports();
  async function measure(round,phase,action){
    active={round,phase,git:{},fsCalls:0,fsMs:0};const row=active,started=performance.now();
    try{return await action();}finally{row.ms=performance.now()-started;samples.push(row);active=null;}
  }
  async function temporary(){return fs.mkdtemp(path.join(tmpdir(),"ai-harness-profile-"));}
  async function cleanup(root){const target=await fs.realpath(root);assert.equal(path.dirname(target),await fs.realpath(tmpdir()));assert.ok(path.basename(target).startsWith("ai-harness-profile-"));await fs.rm(target,{recursive:true,force:true});}
  let payloadFiles=0;
  try{
    for(let round=1;round<=rounds;round++){
      payloadFiles=(await measure(round,"installation-list",()=>installationFiles(sourceRoot))).length;
      const root=await temporary();
      try{
        await measure(round,"install",()=>installRuntime(sourceRoot,root));
        await measure(round,"git-setup",async()=>{
          git(root,["init"]);git(root,["config","user.email","profile@example.invalid"]);git(root,["config","user.name","Harness Profile"]);
        });
        await measure(round,"initialize",()=>initializeProject(root,{mode:"existing",docsMode:"existing"}));
        await measure(round,"git-commit",async()=>{git(root,["add","."]);git(root,["commit","-m","fixed profile baseline"]);});
        assert.equal((await measure(round,"git-baseline",()=>getGitBaseline(root))).dirty,false);
        assert.ok((await measure(round,"snapshot-clean",()=>sourceSnapshot(root))).digest);
        await measure(round,"begin",()=>beginWorkItem(root,{id:"PROFILE",type:"ITERATION",title:"fixed local verification workflow",references:["profile fixture"],acceptance:["declared syntax check passes"],authorizationMode:"autonomous",authorizationSource:"isolated profiling fixture",risk:"medium",approach:"write one module and verify",databaseEvidence:"no database",writeScopes:["sample.mjs"],verification:["node --check sample.mjs"],docsImpact:["N/A: unchanged fixture contract"]}));
        await fs.writeFile(path.join(root,"sample.mjs"),"export const value=1;\n");
        assert.ok((await measure(round,"snapshot-dirty",()=>sourceSnapshot(root))).digest);
        const command=await measure(round,"run",()=>runRecordedCommand(root,{id:"PROFILE",taskId:"T1",checkId:"V1"}));
        assert.equal(command.status,"pass");
        const done=await measure(round,"finish",()=>finishWorkItem(root,"PROFILE",{commandIds:[command.id],verification:"actual syntax check passed",review:"fixture diff checked",documentation:"N/A: fixture",acceptance:"syntax acceptance verified"}));
        assert.equal(done.status,"DONE");
        assert.equal((await measure(round,"check",()=>checkProject(root,{ci:true}))).ok,true);
      }finally{await cleanup(root);}
    }
    const parent=await temporary();
    try{
      const outputDirectory=path.join(parent,"experiment");
      await runExperiment({plan:experimentPlan({weak:"synthetic",comparison:"paired",suite:"project",timeoutMs:5000}),sourceRoot,outputDirectory,mode:"simulated",driver:async({root,outputDirectory:output})=>{
        for(const [file,content]of Object.entries(projectTasks[0].reference))await fs.writeFile(path.join(root,file),content);
        await fs.writeFile(path.join(output,"events.jsonl"),'{"type":"synthetic"}\n');
        return {mode:"simulated",client:"codex",completed:true,final:{completed:true,summary:"profile fixture only",tests:[]},durationMs:1,usage:null};
      }});
      const protocol=JSON.parse(await fs.readFile(path.join(outputDirectory,"protocol.json"),"utf8"));
      for(let round=1;round<=rounds;round++)assert.equal((await measure(round,"execution-audit-two-trials",()=>readExecution(outputDirectory,protocol))).rows.length,2);
    }finally{await cleanup(parent);}
    const ms=value=>Math.round(value*100)/100;
    const phases=[...new Set(samples.map(row=>row.phase))].map(phase=>{
      const rows=samples.filter(row=>row.phase===phase),times=rows.map(row=>row.ms).sort((a,b)=>a-b);
      return {phase,medianMs:ms(times[2]),maxMs:ms(times.at(-1)),gitCalls:rows.map(row=>Object.values(row.git).reduce((sum,entry)=>sum+entry.calls,0)),gitMs:rows.map(row=>ms(Object.values(row.git).reduce((sum,entry)=>sum+entry.ms,0))),fsCalls:rows.map(row=>row.fsCalls)};
    });
    console.log("PROFILE "+JSON.stringify({node:process.version,platform:process.platform,rounds,payloadFiles,phases,samples:samples.map(row=>({...row,ms:ms(row.ms),fsMs:ms(row.fsMs),git:Object.fromEntries(Object.entries(row.git).map(([key,value])=>[key,{calls:value.calls,ms:ms(value.ms)}]))})),limitations:"One local environment and fixed fixture; timings include instrumentation. FS time may overlap and must not be added to wall time. The two-trial audit is simulated, not model performance."}));
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
