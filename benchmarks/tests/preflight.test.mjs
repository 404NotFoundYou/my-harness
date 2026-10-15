import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { memoryPreflightReady, preflightCodex } from "../preflight.mjs";

const complete=()=>({clientVersionKnown:true,feature:{disabled:true},prompt:{contextControl:true,memoryPositive:true,memoryNegative:true},filesystem:{controlReadable:true,externalDenied:true,memoryDenied:true,sandboxStateUnchanged:true},environmentStable:true});
test("readiness requires positive and negative evidence, not just a disabled memory flag",()=>{
 assert.equal(memoryPreflightReady(complete()),true);
 for(const [group,key]of[["feature","disabled"],["prompt","contextControl"],["prompt","memoryPositive"],["prompt","memoryNegative"],["filesystem","controlReadable"],["filesystem","externalDenied"],["filesystem","memoryDenied"],["filesystem","sandboxStateUnchanged"]]){
  for(const value of[false,null,undefined,"true"]){const checks=complete();checks[group][key]=value;assert.equal(memoryPreflightReady(checks),false,group+"/"+key+" cannot be assumed");}
 }
 for(const key of ["environmentStable","clientVersionKnown"]){const changed=complete();changed[key]=false;assert.equal(memoryPreflightReady(changed),false);}
});

for(const scenario of ["readable-host", "active-deny", "unknown-state", "native-entry"]) test("the no-model preflight preserves "+scenario+" evidence and never launches exec",async context=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"ai-harness-preflight-test-"))),home=path.join(root,"home"),previous=process.env.CODEX_HOME;
 const platform=Object.getOwnPropertyDescriptor(process,"platform");process.env.CODEX_HOME=home;
 try{
  await mkdir(path.join(home,".sandbox"),{recursive:true});await mkdir(path.join(home,"memories"));
  await writeFile(path.join(home,"config.toml"),'private_setting="private-preflight-canary"');await writeFile(path.join(home,"memories","MEMORY.md"),"synthetic host memory");
  await writeFile(path.join(home,".sandbox","setup_marker.json"),'{"version":5}');await writeFile(path.join(home,".sandbox","deny_read_acl_state.json"),scenario === "active-deny" ? '{"principals":{"synthetic":{}}}' : scenario === "unknown-state" ? '{"unknown_state":[]}' : '{"principals":{}}');
  const cli=path.join(root,scenario === "native-entry" ? "fixture.exe" : "fixture.mjs");await writeFile(cli,"// synthetic CLI shape; no models");
  Object.defineProperty(process,"platform",{...platform,value:"win32"});let modelExecutions=0,sandboxExecutions=0;
  context.mock.method(childProcess,"spawnSync",(command,args,options)=>{
   if(args[0]===cli || command===cli){
    const cliArgs=command===cli?args:args.slice(1);
    if(scenario === "native-entry")assert.equal(command,cli,"native CLIs must not be interpreted as JavaScript");
    const operation=cliArgs[0];if(operation==="exec")modelExecutions++;
    assert.ok(["--version","features","debug","sandbox"].includes(operation));
    if(operation==="--version")return{status:0,stdout:"codex-cli 0.156.0\n",stderr:""};
    if(operation==="features")return{status:0,stdout:"memories stable false\n",stderr:""};
    if(operation==="debug"&&args.includes("models"))return{status:0,stdout:'{"models":[]}',stderr:""};
    if(operation==="debug"){
     const contextText=fs.readFileSync(path.join(options.cwd,"AGENTS.md"),"utf8");
     const memoryText=fs.readFileSync(path.join(options.env.CODEX_HOME,"memories","memory_summary.md"),"utf8");
     return{status:0,stdout:JSON.stringify([contextText,...(args.includes("--disable")?[]:[memoryText])]),stderr:""};
    }
    sandboxExecutions++; assert.match(args[args.indexOf("-P") + 1], /^benchmark_memory_check_[0-9a-f]{32}$/);
   }
   return{status:0,stdout:'MEMORY_ACCESS_RESULT=[{"readable":true,"matches":true},{"readable":true,"matches":true},{"readable":true,"contentsRead":false}]\n',stderr:""};
  });syncBuiltinESMExports();
  const outputDirectory=path.join(root,"report");const report=await preflightCodex({cli,model:"synthetic",outputDirectory});
  assert.equal(report.actualModelSessions,0);assert.equal(modelExecutions,0);assert.equal(report.cliVersion,"0.156.0");
  assert.equal(report.checks.feature.disabled,true);assert.equal(report.checks.prompt.contextControl,true);assert.equal(report.checks.prompt.memoryPositive,true);assert.equal(report.checks.prompt.memoryNegative,true);
  if(["readable-host","native-entry"].includes(scenario)){assert.equal(report.checks.filesystem.externalDenied,false);assert.equal(report.checks.filesystem.memoryDenied,false);assert.equal(sandboxExecutions,1);}
  else{assert.equal(report.checks.filesystem.status,"unavailable");assert.equal(sandboxExecutions,0,"existing or unknown denied-read policy must not be cleared by a probe");}
  assert.equal(report.ready,false,"a passing marker check cannot conceal readable or unverified external files");
  assert.deepEqual(report.groups[0].memoryArguments,report.groups[1].memoryArguments);assert.equal(report.groups[0].environmentSha256,report.groups[1].environmentSha256);
  assert.doesNotMatch(JSON.stringify(report),/private-preflight-canary|CONTEXT_CANARY_|MEMORY_CANARY_/);
  assert.equal(JSON.parse(await readFile(path.join(outputDirectory,"preflight.json"),"utf8")).ready,false);
 }finally{
  context.mock.restoreAll();syncBuiltinESMExports();Object.defineProperty(process,"platform",platform);
  if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;
  assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith("ai-harness-preflight-test-"));await rm(root,{recursive:true,force:true});
 }
});
