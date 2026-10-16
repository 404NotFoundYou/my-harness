import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { containerIdentity, loadContainerRuntime, runtimeUser, validateContainerManifest, verifyContainerIdentity } from "../codex-container.mjs";
import { codexArguments, codexDriver } from "../codex-driver.mjs";
import { experimentPlan, runExperiment, validateExperimentProtocol } from "../experiment.mjs";
import { inspectExperiment } from "../status.mjs";
import { selectContainerRuntime } from "../run.mjs";
import { tasksForSuite, taskManifest } from "../task-contract.mjs";

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const imageId="sha256:"+"1".repeat(64),image="fixture/node@sha256:"+"2".repeat(64);
const wrapperIntegrity="sha512-47dfpl2e8F47baSQTE+QaWzF/kKoOeR9YQ2fIBdRGzZZP2/QZ6D0uwLY2ZamS8ypov4UFtg92jZh8m+w65bsGg==",platformIntegrity="sha512-/PX399ISB715skgBBOtOX5aqLxmPQhYC7wDasZnAJhRrtzt3qgs6kjSnimN9T8OFKv4LDAp+uJdN896tQYaTrA==";
const manifestValue=()=>({schemaVersion:1,image,imageId,platform:"linux/amd64",nodeEntry:"/usr/local/bin/node",nodeVersion:"v22.20.0",
  cliEntry:"/opt/codex/bin/codex.js",cliVersion:"0.156.0",cliSha256:"3".repeat(64),nativeEntry:"/opt/codex/bin/codex",nativeSha256:"4".repeat(64),wrapperIntegrity,platformIntegrity});
const ok=(stdout="")=>({status:0,signal:null,error:undefined,stdout,stderr:""});
async function fixture(){const root=await realpath(await mkdtemp(path.join(tmpdir(),"ai-harness-container-driver-")));const manifest=path.join(root,"runtime.json");await writeFile(manifest,JSON.stringify(manifestValue()));return{root,manifest};}
async function cleanup(root){const target=await realpath(root);assert.equal(path.dirname(target),await realpath(tmpdir()));assert.ok(path.basename(target).startsWith("ai-harness-container-driver-"));await rm(target,{recursive:true,force:true});}
const inspectedImage=()=>JSON.stringify([{Id:imageId,Architecture:"amd64",Os:"linux"}]);
const measurement=(overrides={})=>JSON.stringify({nodeVersion:"v22.20.0",cliVersion:"0.156.0",cliSha256:"3".repeat(64),nativeSha256:"4".repeat(64),...overrides});
const hostConfig=(overrides={})=>({NetworkMode:"none",ReadonlyRootfs:true,Privileged:false,CapDrop:["ALL"],SecurityOpt:["no-new-privileges:true"],Tmpfs:{"/tmp":"rw,exec,nosuid,nodev,size=268435456,mode=1777"},PidsLimit:128,Memory:1610612736,NanoCpus:2000000000,RestartPolicy:{Name:"no",MaximumRetryCount:0},PortBindings:{},...overrides});
function dockerMock({workspace=null,output=null,runtimeHostConfig={},identityMeasurement={},runtimeCreateFailure=false}={}){
 const calls=[],containers=new Map(),users=new Map(),removals=[];
 return{calls,removals,handler(command,args){calls.push(args);assert.equal(command,"docker");
  if(args[0]==="image")return ok(inspectedImage());
  if(args[0]==="create"){const name=args[args.indexOf("--name")+1],type=name.startsWith("ai-harness-identity-")?"identity":"runtime";containers.set(name,type);users.set(name,args[args.indexOf("--user")+1]);if(type==="runtime"&&runtimeCreateFailure)return{status:1,signal:null,error:undefined,stdout:"",stderr:"synthetic create uncertainty"};return ok("container-id\n");}
  if(args[0]==="inspect"){const type=containers.get(args[1]);if(type==="identity")return ok(JSON.stringify([{Image:imageId,Config:{User:users.get(args[1]),OpenStdin:true},HostConfig:hostConfig(),Mounts:[]}]));if(type==="runtime")return ok(JSON.stringify([{Image:imageId,Config:{User:users.get(args[1]),OpenStdin:true},HostConfig:hostConfig(runtimeHostConfig),Mounts:[{Type:"bind",Destination:"/workspace",RW:true,Source:workspace},{Type:"bind",Destination:"/output",RW:true,Source:output}]}]));}
  if(args[0]==="start"){if(containers.get(args.at(-1))==="identity")return ok(measurement(identityMeasurement));return ok();}
  if(args[0]==="rm"){removals.push(args);containers.delete(args.at(-1));return ok();}
  if(args[0]==="kill")return ok();
  throw new Error("unexpected docker command "+args.join(" "));
 }};
}

test("container manifest and identity are strict and content addressed",async context=>{
 const fx=await fixture();try{
  assert.deepEqual(validateContainerManifest(manifestValue()),manifestValue());
  assert.throws(()=>validateContainerManifest({...manifestValue(),extra:true}));
  assert.throws(()=>validateContainerManifest({...manifestValue(),cliVersion:"0.157.0"}),/unsupported/i);
  const docker=dockerMock();context.mock.method(childProcess,"spawnSync",docker.handler);
  const identity=await containerIdentity(fx.manifest);
  assert.equal(identity.kind,"container");assert.equal(identity.image,image);assert.equal(identity.imageId,imageId);assert.equal(identity.runtimeVersion,1);
  await writeFile(fx.manifest,JSON.stringify({...manifestValue(),imageId:"sha256:"+"9".repeat(64)}));
  await assert.rejects(()=>containerIdentity(fx.manifest),/image identity/i);
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("container identity rejects manifest hashes that do not match measured image bytes",async context=>{
 const fx=await fixture();try{
  const docker=dockerMock({identityMeasurement:{cliSha256:"9".repeat(64)}});context.mock.method(childProcess,"spawnSync",docker.handler);
  await assert.rejects(()=>containerIdentity(fx.manifest),/CLI hash differs/i);assert.ok(docker.removals.some(args=>args.includes("--force")));
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("container identity recheck does not start a second identity container",async context=>{
 const fx=await fixture();
 try{
  const docker=dockerMock();context.mock.method(childProcess,"spawnSync",docker.handler);
  const identity=await containerIdentity(fx.manifest),before=docker.calls.length;
  assert.deepEqual(await verifyContainerIdentity(fx.manifest,{expected:identity}),identity);
  const recheck=docker.calls.slice(before);assert.ok(recheck.length>0);assert.ok(recheck.every(args=>args[0]==="image"),"recheck must not create or start an identity container");
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("container runtime resume identity load uses lightweight recheck",async context=>{
 const fx=await fixture();
 try{
  const docker=dockerMock();context.mock.method(childProcess,"spawnSync",docker.handler);
  const identity=await containerIdentity(fx.manifest),before=docker.calls.length;
  await loadContainerRuntime(fx.manifest,{expectedIdentity:identity});
  const recheck=docker.calls.slice(before);assert.ok(recheck.length>0);assert.ok(recheck.every(args=>args[0]==="image"),"resume identity load must not create or start an identity container");
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("run resume passes frozen container identity to the lightweight loader",async()=>{
 const fx=await fixture(),output=path.join(fx.root,"experiment"),frozen={kind:"container",manifest:"/frozen/runtime.json"};await mkdir(output);await writeFile(path.join(output,"protocol.json"),JSON.stringify({schemaVersion:4,driverIdentity:frozen}));
 try{
  let received=null;const selected=await selectContainerRuntime({codexRuntime:"docker",manifest:fx.manifest,outputDirectory:output,resume:true,loadRuntime:async(...args)=>{received=args;return "selected";}});
  assert.equal(selected,"selected");assert.deepEqual(received,[fx.manifest,{expectedIdentity:frozen}]);
 }finally{await cleanup(fx.root);}
});

test("container runtime rejects a root POSIX group and keeps the Windows fallback",()=>{
 assert.throws(()=>runtimeUser({uid:1000,gid:0}),/UID and GID/);assert.equal(runtimeUser({uid:null,gid:null}),"65534:65534");
});

test("container runtime inspects hardened mounts before start and owns cleanup",async context=>{
 const fx=await fixture();const workspace=path.join(fx.root,"workspace"),output=path.join(fx.root,"output");await mkdir(workspace);await mkdir(output);const calls=[];
 try{
  const docker=dockerMock({workspace,output});context.mock.method(childProcess,"spawnSync",(command,args)=>{calls.push(args);return docker.handler(command,args);});
  const loaded=await loadContainerRuntime(fx.manifest),mapped=loaded.runtime.paths({root:workspace,outputDirectory:output});
  assert.deepEqual(mapped,{root:"/workspace",outputDirectory:"/output"});
  const launch=await loaded.runtime.prepare({root:workspace,outputDirectory:output,args:["exec","-"]});
  assert.equal(launch.command,"docker");assert.deepEqual(launch.args.slice(0,3),["start","--attach","--interactive"]);
  assert.equal(launch.stop(),null);assert.equal(launch.cleanup(),null);
  assert.ok(calls.some(args=>args[0]==="create"&&args.includes("--pull")&&args.includes("never")));
   const expectedUser=typeof process.getuid==="function"?`${process.getuid()}:${process.getgid()}`:"65534:65534";
   const runtimeCreate=calls.find(args=>args[0]==="create"&&args[args.indexOf("--name")+1].startsWith("ai-harness-codex-"));assert.equal(runtimeCreate[runtimeCreate.indexOf("--user")+1],expectedUser);
  assert.ok(calls.some(args=>args[0]==="inspect"));assert.ok(calls.some(args=>args[0]==="kill"));assert.ok(calls.some(args=>args[0]==="rm"));
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("container runtime removes a container when inspect reveals a weaker boundary",async context=>{
 const fx=await fixture();const workspace=path.join(fx.root,"workspace"),output=path.join(fx.root,"output");await mkdir(workspace);await mkdir(output);const removals=[];
 try{
  const docker=dockerMock({workspace,output,runtimeHostConfig:{NetworkMode:"bridge"}});context.mock.method(childProcess,"spawnSync",(command,args)=>{const result=docker.handler(command,args);removals.splice(0,removals.length,...docker.removals);return result;});
  const loaded=await loadContainerRuntime(fx.manifest);
  await assert.rejects(()=>loaded.runtime.prepare({root:workspace,outputDirectory:output,args:["exec"]}),/network must be disabled/i);
  const runtimeRemovals=removals.filter(args=>args.at(-1).startsWith("ai-harness-codex-"));assert.equal(runtimeRemovals.length,1);assert.deepEqual(runtimeRemovals[0].slice(0,3),["rm","--force","--volumes"]);
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("container runtime cleans an uncertain create result by its preallocated name",async context=>{
 const fx=await fixture();const workspace=path.join(fx.root,"workspace"),output=path.join(fx.root,"output");await mkdir(workspace);await mkdir(output);
 try{
  const docker=dockerMock({workspace,output,runtimeCreateFailure:true});context.mock.method(childProcess,"spawnSync",docker.handler);const loaded=await loadContainerRuntime(fx.manifest);
  await assert.rejects(()=>loaded.runtime.prepare({root:workspace,outputDirectory:output,args:["exec"]}),/creation failed/i);const runtimeRemovals=docker.removals.filter(args=>args.at(-1).startsWith("ai-harness-codex-"));assert.equal(runtimeRemovals.length,1);assert.deepEqual(runtimeRemovals[0].slice(0,3),["rm","--force","--volumes"]);
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("container runtime rejects every weakened resource boundary",async context=>{
 const cases=[
  ["tmpfs",{Tmpfs:{"/tmp":"rw"}},/tmpfs differs/i],
  ["pids",{PidsLimit:127},/PID limit differs/i],
  ["memory",{Memory:1024},/memory limit differs/i],
  ["cpu",{NanoCpus:1},/CPU limit differs/i],
  ["restart",{RestartPolicy:{Name:"always",MaximumRetryCount:0}},/restart policy differs/i],
 ];
 for(const[label,override,pattern]of cases)await context.test(label,async childContext=>{
  const fx=await fixture();const workspace=path.join(fx.root,"workspace"),output=path.join(fx.root,"output");await mkdir(workspace);await mkdir(output);
  try{const docker=dockerMock({workspace,output,runtimeHostConfig:override});childContext.mock.method(childProcess,"spawnSync",docker.handler);const loaded=await loadContainerRuntime(fx.manifest);await assert.rejects(()=>loaded.runtime.prepare({root:workspace,outputDirectory:output,args:["exec"]}),pattern);assert.equal(docker.removals.filter(args=>args.includes("--force")).length>=1,true);}finally{childContext.mock.restoreAll();await cleanup(fx.root);}
 });
});

test("container arguments disable external tools and bypass only the inner sandbox",()=>{
 const host=codexArguments({root:"C:/workspace",outputDirectory:"C:/output",model:"fixture",budget:{reasoning:"medium"}});
 assert.deepEqual(host.slice(0,9),["exec","--disable","memories","--ephemeral","--json","--color","never","--sandbox","workspace-write"],"host argument ordering remains compatible");
 const args=codexArguments({root:"/workspace",outputDirectory:"/output",model:"fixture",budget:{reasoning:"medium"},container:true});
 assert.ok(args.includes("--dangerously-bypass-approvals-and-sandbox"));assert.equal(args.includes("workspace-write"),false);
 for(const feature of["apps","plugins","browser_use","browser_use_external","computer_use","image_generation","remote_plugin","in_app_browser","enable_mcp_apps","codex_apps_mcp_2026_07_28","mcp_2026_07_28","standalone_web_search","tool_call_mcp_elicitation","skill_mcp_dependency_install"]){const index=args.findIndex((value,offset)=>value==="--disable"&&args[offset+1]===feature);assert.ok(index>=0,feature+" must be disabled");}
 assert.ok(args.includes('web_search="disabled"'));assert.ok(args.includes("mcp_servers={}"));assert.deepEqual(args.slice(0,3),["exec","--disable","memories"]);
});

for(const scenario of["timeout","tool-limit"]){
 test("container driver owns stop and cleanup after "+scenario,async context=>{
  const fx=await fixture();const output=path.join(fx.root,"output");await mkdir(output);const child=new EventEmitter();child.pid=24680;child.exitCode=null;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let stopped=0,cleaned=0,closed=false;
  const close=()=>{if(closed)return;closed=true;child.exitCode=1;child.stdout.end();child.stderr.end();child.emit("exit",1);child.emit("close",1);};child.kill=()=>{close();return true;};
  const runtime={paths:()=>({root:"/workspace",outputDirectory:"/output"}),prepare:async()=>({command:"docker",args:["start"],cwd:fx.root,detached:false,stop(){stopped++;return null;},cleanup(){cleaned++;return null;}})};
  try{
   context.mock.method(childProcess,"spawn",()=>{if(scenario==="tool-limit")queueMicrotask(()=>child.stdout.write(JSON.stringify({type:"item.started",item:{id:"tool",type:"command_execution"}})+"\n"));return child;});
   context.mock.method(childProcess,"spawnSync",()=>{close();return ok();});syncBuiltinESMExports();
   context.mock.method(process,"kill",()=>{close();return true;});
   const result=await codexDriver("/opt/codex.js",{runtime})({root:fx.root,model:"fixture",prompt:"No model calls",budget:{timeoutMs:scenario==="timeout"?20:5000,maxToolCalls:scenario==="tool-limit"?1:5,reasoning:"medium"},outputDirectory:output});
   assert.equal(scenario==="timeout"?result.timedOut:result.toolLimit,true);assert.equal(result.completed,false);assert.equal(stopped,1);assert.equal(cleaned,1);
  }finally{context.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.root);}
 });
}

test("container driver preserves both stop and remove failures",async context=>{
 const fx=await fixture();const output=path.join(fx.root,"output");await mkdir(output);const child=new EventEmitter();child.pid=24682;child.exitCode=null;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();let closed=false;const close=()=>{if(closed)return;closed=true;child.exitCode=1;child.stdout.end();child.stderr.end();child.emit("exit",1);child.emit("close",1);};child.kill=()=>{close();return true;};
 const runtime={paths:()=>({root:"/workspace",outputDirectory:"/output"}),prepare:async()=>({command:"docker",args:["start"],cwd:fx.root,detached:false,stop(){return"synthetic stop failure";},cleanup(){return"synthetic cleanup failure";}})};
 try{context.mock.method(childProcess,"spawn",()=>child);context.mock.method(childProcess,"spawnSync",()=>{close();return ok();});context.mock.method(process,"kill",()=>{close();return true;});syncBuiltinESMExports();const result=await codexDriver("/opt/codex.js",{runtime})({root:fx.root,model:"fixture",prompt:"No model calls",budget:{timeoutMs:20,maxToolCalls:5,reasoning:"medium"},outputDirectory:output});assert.match(result.error,/stop failure/);assert.match(result.error,/cleanup failure/);assert.equal(result.completed,false);}finally{context.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.root);}
});

test("container cleanup failure invalidates an otherwise terminal run",async context=>{
 const fx=await fixture();const output=path.join(fx.root,"output");await mkdir(output);const child=new EventEmitter();child.pid=24681;child.exitCode=null;child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
 const runtime={paths:()=>({root:"/workspace",outputDirectory:"/output"}),prepare:async()=>({command:"docker",args:["start"],cwd:fx.root,detached:false,stop(){return null;},cleanup(){return"synthetic cleanup failure";}})};
 try{
  context.mock.method(childProcess,"spawn",()=>{queueMicrotask(async()=>{await writeFile(path.join(output,"final.json"),JSON.stringify({completed:true,summary:"fixture",tests:[]}));child.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:0,output_tokens:0}})+"\n");child.stdout.end();child.stderr.end();child.exitCode=0;child.emit("exit",0);child.emit("close",0);});return child;});syncBuiltinESMExports();
  const result=await codexDriver("/opt/codex.js",{runtime})({root:fx.root,model:"fixture",prompt:"No model calls",budget:{timeoutMs:5000,maxToolCalls:5,reasoning:"medium"},outputDirectory:output});
  assert.match(result.error,/cleanup failure/);assert.equal(result.completed,false);
 }finally{context.mock.restoreAll();syncBuiltinESMExports();await cleanup(fx.root);}
});

test("container identity remains protocol v4 compatible and drift stops before the driver",async context=>{
 const fx=await fixture();const output=path.join(fx.root,"experiment");let driverCalls=0;
 try{
  const docker=dockerMock();context.mock.method(childProcess,"spawnSync",docker.handler);
  const identity=await containerIdentity(fx.manifest),plan=experimentPlan({weak:"fixture",comparison:"paired",suite:"project",timeoutMs:5000});
  const protocol={...plan,mode:"real",source:"0".repeat(64),tasks:tasksForSuite("project").map(taskManifest),driverIdentity:identity,summaryVersion:2,createdAt:"2026-10-15T00:00:00Z"};
  validateExperimentProtocol(protocol);
  await assert.rejects(()=>runExperiment({plan,sourceRoot,outputDirectory:output,driverIdentity:identity,readDriverIdentity:async()=>({...identity,imageId:"sha256:"+"8".repeat(64)}),driver:async()=>{driverCalls++;}}),/identity changed/i);
  assert.equal(driverCalls,0);
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("status can verify a frozen container identity without executing a client",async context=>{
 const fx=await fixture();const output=path.join(fx.root,"experiment");
 try{
  const docker=dockerMock();context.mock.method(childProcess,"spawnSync",docker.handler);
  const identity=await containerIdentity(fx.manifest),plan=experimentPlan({weak:"fixture",comparison:"paired",suite:"project",timeoutMs:5000});
  await assert.rejects(()=>runExperiment({plan,sourceRoot,outputDirectory:output,driverIdentity:identity,readDriverIdentity:async()=>identity,driver:async()=>{throw new Error("driver must not run");},onProgress:event=>{if(event.event==="ready")throw new Error("pause");}}),/pause/);
  const report=await inspectExperiment({sourceRoot,outputDirectory:output,containerManifest:fx.manifest});
  assert.equal(report.driver.status,"matched");assert.equal(report.driver.basis,"explicit-container-manifest");assert.equal(report.resume.canResume,true);
 }finally{context.mock.restoreAll();await cleanup(fx.root);}
});

test("docker dry-run freezes budget without reading a manifest or Docker",()=>{
 const result=spawnSync(process.execPath,[path.join(sourceRoot,"benchmarks/run.mjs"),"--codex-runtime","docker","--codex-container-manifest","not-present.json","--weak","fixture","--comparison","paired","--suite","project","--out","unused","--dry-run"],{cwd:sourceRoot,shell:false,windowsHide:true,encoding:"utf8",timeout:5000});
 assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);assert.equal(output.codexRuntime,"docker");assert.equal(output.dryRun,true);assert.ok(output.modelCalls>0);
});

test("runtime CLI rejects ambiguous or unsupported combinations",()=>{
 const base=[path.join(sourceRoot,"benchmarks/run.mjs"),"--weak","fixture","--comparison","paired","--suite","project","--out","unused","--dry-run"];
 for(const args of[["--codex-runtime","docker","--codex-container-manifest","fixture.json","--cli","fixture.mjs"],["--codex-runtime","host","--codex-container-manifest","fixture.json","--cli","fixture.mjs"],["--codex-runtime","docker","--codex-container-manifest","fixture.json","--client","claude"]]){
  const result=spawnSync(process.execPath,[...base,...args],{cwd:sourceRoot,shell:false,windowsHide:true,encoding:"utf8",timeout:5000});assert.notEqual(result.status,0);
 }
});
