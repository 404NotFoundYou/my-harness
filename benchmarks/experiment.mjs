import path from "node:path";
import { mkdir, readFile, realpath } from "node:fs/promises";
import assert from "node:assert/strict";
import { taskManifest, tasksForSuite } from "./task-contract.mjs";
import { budget, groups, hash, runCase, saveJson } from "./runner.mjs";
import { sourceSnapshot } from "../.ai-harness/src/snapshot.mjs";
import { redact } from "../.ai-harness/src/evidence.mjs";
import { resolveProjectPath } from "../.ai-harness/src/filesystem.mjs";
import { inspectLock, recoverLock, withFileLock } from "../.ai-harness/src/locking.mjs";
import { readExperimentFile } from "./audit-trial.mjs";
import { executionSummary, initialExecution, readExecution } from "./execution.mjs";

export function experimentPlan({ weak, strong, client = "codex", comparison = "reference", repetitions = 1, timeoutMs = budget.timeoutMs, maxToolCalls = budget.maxToolCalls, suite = "core" }) {
  const tasks=tasksForSuite(suite);
  if (!["codex", "claude", "gemini"].includes(client) || !["paired", "reference"].includes(comparison)) throw new Error("Invalid client or comparison");
  if (typeof weak !== "string" || !weak.trim() || (comparison === "reference" && (typeof strong !== "string" || !strong.trim()))) throw new Error("Models must be explicit");
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error("repetitions must be 1..100");
  if (![timeoutMs, maxToolCalls].every(value => Number.isSafeInteger(value) && value > 0) || timeoutMs > 2147483647) throw new Error("Budgets must be positive integers within the timer range");
  const matrix = groups(weak, strong).filter(group => comparison === "reference" || group.id !== "strong-reference");
  const schedule = [];
  for (let trial = 1; trial <= repetitions; trial++) for (let index = 0; index < tasks.length; index++) for (let offset = 0; offset < matrix.length; offset++) {
    const group = matrix[(index + trial - 1 + offset) % matrix.length];
    schedule.push({ taskId: tasks[index].id, group: group.id, trial, directory: `${tasks[index].id}-${group.id}${repetitions > 1 ? `-trial-${trial}` : ""}` });
  }
  return { schemaVersion: 4, suite, client, comparison, repetitions, groups: matrix, budget: { timeoutMs, maxToolCalls, reasoning: client === "gemini" ? null : budget.reasoning }, schedule };
}

export async function cliIdentity(cli) {
  const entry=await realpath(cli);
  return {kind:"cli",entry,sha256:hash(await readFile(entry)),nodeVersion:process.version};
}

function checkedIdentity(mode, driver, identity) {
  const value=identity ?? (mode === "simulated" ? {kind:"simulated",fingerprint:hash(driver.toString())} : null);
  assert.ok(value&&typeof value === "object"&&!Array.isArray(value),"A real experiment needs its CLI identity");
  if(mode === "simulated"){
    assert.deepEqual(Object.keys(value).sort(),["fingerprint","kind"],"Invalid simulated driver identity");
    assert.equal(value.kind,"simulated");
    assert.match(value.fingerprint,/^[a-f0-9]{64}$/);
  }else{
    assert.deepEqual(Object.keys(value).sort(),["entry","kind","nodeVersion","sha256"],"Invalid CLI identity");
    assert.equal(value.kind,"cli");
    assert.ok(typeof value.entry === "string"&&path.isAbsolute(value.entry));
    assert.match(value.sha256,/^[a-f0-9]{64}$/);
    assert.equal(typeof value.nodeVersion,"string");
  }
  return structuredClone(value);
}

export function validateExperimentProtocol(protocol) {
  assert.equal(protocol.schemaVersion,4,"Only protocol v4 can resume; historical experiments are read-only");
  assert.ok(["real","simulated"].includes(protocol.mode),"Invalid experiment mode");
  assert.match(protocol.source,/^[a-f0-9]{64}$/,"Invalid source digest");
  const {createdAt,...stored}=protocol;
  assert.ok(typeof createdAt === "string"&&Number.isFinite(Date.parse(createdAt)),"Invalid protocol creation time");
  const plan=experimentPlan({weak:protocol.groups.find(group=>group.id==="weak-baseline")?.model,strong:protocol.groups.find(group=>group.id==="strong-reference")?.model,client:protocol.client,comparison:protocol.comparison,repetitions:protocol.repetitions,timeoutMs:protocol.budget.timeoutMs,maxToolCalls:protocol.budget.maxToolCalls,suite:protocol.suite});
  assert.deepEqual(stored,{...plan,mode:protocol.mode,source:protocol.source,tasks:tasksForSuite(plan.suite).map(taskManifest),driverIdentity:checkedIdentity(protocol.mode,null,protocol.driverIdentity)},"Invalid frozen protocol");
}

export async function runExperiment({ plan, sourceRoot, outputDirectory, driver, mode = "real", onProgress = () => {}, resume = false, driverIdentity = null }) {
  assert.ok(["real","simulated"].includes(mode),"Invalid experiment mode");
  assert.equal(typeof resume,"boolean","resume must be a boolean");
  const expected=experimentPlan({weak:plan.groups.find(group=>group.id==="weak-baseline")?.model,strong:plan.groups.find(group=>group.id==="strong-reference")?.model,client:plan.client,comparison:plan.comparison,repetitions:plan.repetitions,timeoutMs:plan.budget.timeoutMs,maxToolCalls:plan.budget.maxToolCalls,suite:plan.suite});
  assert.deepEqual(plan,expected,"Experiment plan differs from the declared task suite");
  plan=expected;
  if(!resume)await mkdir(outputDirectory);
  outputDirectory=await realpath(outputDirectory);
  const identity=checkedIdentity(mode,driver,driverIdentity);
  const source=(await sourceSnapshot(sourceRoot)).digest;
  const tasks=tasksForSuite(plan.suite);
  const frozen={...plan,mode,source,tasks:tasks.map(taskManifest),driverIdentity:identity};
  const lock=await resolveProjectPath(outputDirectory,".experiment.lock",{forWrite:true});
  const save=async(file,value)=>saveJson(await resolveProjectPath(outputDirectory,file,{forWrite:true}),value);
  const assertSource=async()=>{
    assert.equal((await sourceSnapshot(sourceRoot)).digest,source,"Harness source changed during the experiment");
    if(mode === "real")assert.deepEqual(await cliIdentity(identity.entry),identity,"CLI identity changed during the experiment");
  };
  async function load(){
    await assertSource();
    const protocol=JSON.parse((await readExperimentFile(outputDirectory,"protocol.json")).toString("utf8"));
    validateExperimentProtocol(protocol);
    const {createdAt,...stored}=protocol;
    assert.deepEqual(stored,frozen,"Frozen protocol, source or driver differs");
    return {protocol,...await readExecution(outputDirectory,protocol)};
  }
  if(resume){
    const owner=await inspectLock(lock);
    if(owner.status === "stale")await recoverLock(lock,owner.owner.token,load);
  }
  return withFileLock(lock,async()=>{
    if(!resume){
      await save("protocol.json",{...frozen,createdAt:new Date().toISOString()});
      const bytes=await readExperimentFile(outputDirectory,"protocol.json");
      await save("execution.json",initialExecution(JSON.parse(bytes.toString("utf8")),bytes));
    }
    // Re-read under the acquired lock, including after stale-owner recovery.
    const loaded=await load(),protocol=loaded.protocol;
    if(loaded.changed)await save("execution.json",loaded.ledger);
    let ledger=loaded.ledger,rows=loaded.rows;
    async function summary(error=null){
      const value=executionSummary(protocol,ledger,rows,(await sourceSnapshot(sourceRoot)).digest,error);
      await save("summary.json",value);
      return value;
    }
    await summary();
    try{
      onProgress({event:"ready",resume,remaining:ledger.trials.filter(state=>state.status === "pending").length});
      for(const [index,entry]of protocol.schedule.entries()){
        if(ledger.trials[index].status !== "pending")continue;
        await assertSource();
        const destination=await resolveProjectPath(outputDirectory,entry.directory,{forWrite:true});
        ledger.trials[index]={directory:entry.directory,status:"started",startedAt:new Date().toISOString()};
        await save("execution.json",ledger);
        const task=tasks.find(task=>task.id===entry.taskId),group=protocol.groups.find(group=>group.id===entry.group);
        onProgress({event:"started",...entry,model:group.model});
        await runCase({task,group,trial:entry.trial,sourceRoot,outputDirectory:destination,driver,runBudget:{...protocol.budget},execution:{protocolSha256:ledger.protocolSha256,sourceBefore:source},beforePublish:assertSource});
        await assertSource();
        const current=await readExecution(outputDirectory,protocol);
        ledger=current.ledger;rows=current.rows;
        await save("execution.json",ledger);
        const result=rows.find(row=>row.taskId===entry.taskId&&row.group===entry.group&&row.trial===entry.trial);
        onProgress({event:"finished",...entry,functional:result.grade.ok,success:result.success,timeout:result.run.timedOut,durationMs:result.run.durationMs});
        await summary();
      }
      await assertSource();
      return summary();
    }catch(error){
      try{
        const current=await readExecution(outputDirectory,protocol);
        ledger=current.ledger;rows=current.rows;
        if(current.changed)await save("execution.json",ledger);
        await summary(redact(error.message));
      }catch(recoveryError){
        throw new AggregateError([error,recoveryError],`Experiment failed and evidence could not be reconciled: ${redact(error.message)}; ${redact(recoveryError.message)}`);
      }
      throw error;
    }
  },0);
}
