import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { captureCodexEnvironment, validateCodexEnvironment, codexMemoryArguments } from "../codex-environment.mjs";
import { cliIdentity, experimentPlan, runExperiment, validateExperimentProtocol } from "../experiment.mjs";
import { tasksForSuite, taskManifest } from "../task-contract.mjs";
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
async function fixture(){const root=await realpath(await mkdtemp(path.join(tmpdir(),"ai-harness-memory-control-")));const home=path.join(root,"home");await mkdir(home);return{root,home};}
async function cleanup(root){assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith("ai-harness-memory-control-"));await rm(root,{recursive:true,force:true});}

test("context fingerprints detect configuration, memory and manifest drift without storing private contents",async()=>{
 const {root,home}=await fixture();try{
  await mkdir(path.join(home,"memories"));await mkdir(path.join(home,"skills","fixture"),{recursive:true});await mkdir(path.join(home,"plugins","cache","fixture"),{recursive:true});
  await writeFile(path.join(home,"config.toml"),'private_setting="private-context-canary"');
  await writeFile(path.join(home,"memories","MEMORY.md"),"private-memory-canary");await writeFile(path.join(home,"skills","fixture","SKILL.md"),"fixture v1");
  await writeFile(path.join(home,"plugins","cache","fixture","plugin.json"),'{"version":"1"}');
  const options={home,userHome:root},before=await captureCodexEnvironment(options);validateCodexEnvironment(before);
  assert.deepEqual(before.arguments,["--disable","memories"]);assert.deepEqual(before,await captureCodexEnvironment(options));
  assert.doesNotMatch(JSON.stringify(before),/private-context-canary|private-memory-canary/);
  for(const file of["config.toml","memories/MEMORY.md","skills/fixture/SKILL.md","plugins/cache/fixture/plugin.json"]){
   const target=path.join(home,file),original=await readFile(target);await writeFile(target,"changed fixture");
   assert.notEqual((await captureCodexEnvironment(options)).sha256,before.sha256,"paired sessions must not silently consume changed "+file);await writeFile(target,original);
  }
  for(const invalid of[{...before,version:2},{...before,sha256:"0".repeat(64)},{...before,arguments:[]},{...before,extra:"private-context-canary"}])assert.throws(()=>validateCodexEnvironment(invalid));
  assert.deepEqual(codexMemoryArguments,["--disable","memories"]);
 }finally{await cleanup(root);}
});

test("new environment identities are optional for legacy v4 but drift stops before any paid driver",async()=>{
 const {root,home}=await fixture(),previous=process.env.CODEX_HOME;process.env.CODEX_HOME=home;
 try{
  const cli=path.join(root,"fixture.mjs");await writeFile(cli,"// no model service");await writeFile(path.join(home,"config.toml"),"fixture=1");
  const legacy=await cliIdentity(cli),identity=await cliIdentity(cli,{codexEnvironment:true});
  assert.equal(legacy.environment,undefined);validateCodexEnvironment(identity.environment);
  const plan=experimentPlan({weak:"synthetic",suite:"project",comparison:"paired",timeoutMs:5000});
  const protocol={...plan,mode:"real",source:"0".repeat(64),tasks:tasksForSuite("project").map(taskManifest),driverIdentity:identity,summaryVersion:2,createdAt:"2026-10-15T00:00:00Z"};
  validateExperimentProtocol(protocol);validateExperimentProtocol({...protocol,driverIdentity:legacy});
  assert.throws(()=>validateExperimentProtocol({...protocol,driverIdentity:{...identity,environment:{...identity.environment,sha256:"f".repeat(64)}}}));
  await writeFile(path.join(home,"config.toml"),"fixture=2");let calls=0;
  await assert.rejects(()=>runExperiment({plan,sourceRoot,outputDirectory:path.join(root,"experiment"),driverIdentity:identity,driver:async()=>{calls++;throw new Error("must never execute");}}),/environment changed/);
  assert.equal(calls,0,"changed contexts must be rejected before a possibly billable session");
 }finally{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;await cleanup(root);}
});
