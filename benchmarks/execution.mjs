import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import { resolveProjectPath } from "../.ai-harness/src/filesystem.mjs";
import { auditTrial, readExperimentFile } from "./audit-trial.mjs";
import { tasksForSuite } from "./task-contract.mjs";
import { hash, summarize } from "./runner.mjs";
import { hasCompleteUsage } from "./statistics.mjs";

export function initialExecution(protocol, protocolBytes) {
  return {schemaVersion:1,protocolSha256:hash(protocolBytes),trials:protocol.schedule.map(entry=>({directory:entry.directory,status:"pending"}))};
}

export async function readExecutionLedger(directory, protocol, {readEvidence=file=>readExperimentFile(directory,file)} = {}) {
  assert.equal(protocol.schemaVersion,4,"Only protocol v4 can resume");
  const protocolBytes=await readEvidence("protocol.json");
  assert.deepEqual(JSON.parse(protocolBytes.toString("utf8")),protocol,"Protocol changed while loading");
  const ledger=JSON.parse((await readEvidence("execution.json")).toString("utf8"));
  assert.deepEqual(Object.keys(ledger).sort(),["protocolSha256","schemaVersion","trials"],"Invalid execution ledger");
  assert.equal(ledger.schemaVersion,1,"Invalid execution ledger version");
  assert.equal(ledger.protocolSha256,hash(protocolBytes),"Protocol hash differs from execution ledger");
  assert.ok(Array.isArray(ledger.trials),"Invalid execution trials");
  assert.deepEqual(ledger.trials.map(row=>row.directory),protocol.schedule.map(row=>row.directory),"Execution trials differ from frozen schedule");
  for (const state of ledger.trials) {
    assert.ok(["pending","started","completed","interrupted"].includes(state.status),"Invalid execution trial status");
    const keys=["directory","status",...(state.status === "pending" ? [] : ["startedAt"]),...(state.status === "completed" ? ["resultSha256"] : []),...(state.status === "interrupted" ? ["reason"] : [])].sort();
    assert.deepEqual(Object.keys(state).sort(),keys,"Invalid execution trial fields");
    if(state.status !== "pending")assert.ok(typeof state.startedAt === "string"&&Number.isFinite(Date.parse(state.startedAt)),"Invalid execution start time");
    if(state.status === "interrupted")assert.equal(state.reason,"result-unavailable","Invalid interruption reason");
    if(state.status === "completed")assert.match(state.resultSha256,/^[a-f0-9]{64}$/, "Invalid result hash");
  }
  return ledger;
}

export async function reconcileTrial(directory, protocol, entry, state, readEvidence = file => readExperimentFile(directory, file)) {
  const trialPath=await resolveProjectPath(directory,entry.directory,{forWrite:true});
  const info=await lstat(trialPath).catch(error=>{if(error.code === "ENOENT")return null;throw error;});
  if(state.status === "pending"){
    assert.equal(info,null,"A pending trial already has output; refusing to repeat a possible call");
    return null;
  }
  if(info)assert.ok(info.isDirectory()&&!info.isSymbolicLink(),"Invalid trial directory");
  const bytes=await readEvidence(`${entry.directory}/result.json`).catch(error=>{if(error.code === "ENOENT")return null;throw error;});
  if(state.status === "interrupted"){
    assert.equal(bytes,null,"Interrupted trial gained an unexpected result");
    return null;
  }
  if(state.status === "completed")assert.ok(bytes,"Completed trial result is missing");
  if(!bytes){
    state.status="interrupted";
    state.reason="result-unavailable";
    return null;
  }
  const resultSha256=hash(bytes);
  if(state.status === "completed")assert.equal(state.resultSha256,resultSha256,"Completed trial result hash differs");
  const task=tasksForSuite(protocol.suite).find(task=>task.id===entry.taskId);
  const group=protocol.groups.find(group=>group.id===entry.group);
  const row=await auditTrial(directory,protocol,task,group,entry.trial,bytes.toString("utf8"),readEvidence);
  state.status="completed";
  state.resultSha256=resultSha256;
  return row;
}

export async function readExecution(directory, protocol, {readEvidence=file=>readExperimentFile(directory,file)} = {}) {
  const ledger=await readExecutionLedger(directory,protocol,{readEvidence});
  const rows=[],before=JSON.stringify(ledger);
  for (const [index,state] of ledger.trials.entries()) {
    const row=await reconcileTrial(directory,protocol,protocol.schedule[index],state,readEvidence);
    if(row)rows.push(row);
  }
  return {ledger,rows,changed:before !== JSON.stringify(ledger)};
}

export function executionSummary(protocol, ledger, rows, sourceAfter, error = null) {
  const states=ledger.trials.map((state,index)=>({...protocol.schedule[index],...state}));
  return {...(protocol.summaryVersion===undefined?{}:{summaryVersion:protocol.summaryVersion}),mode:protocol.mode,complete:states.every(state=>state.status === "completed")&&sourceAfter === protocol.source&&error === null,
    sourceBefore:protocol.source,sourceAfter,error,
    results:rows.map(row=>({taskId:row.taskId,group:row.group,trial:row.trial,success:row.success,functionalPassed:row.grade.ok})),
    notRun:protocol.schedule.filter((entry,index)=>states[index].status === "pending"),
    interrupted:states.filter(state=>state.status === "interrupted").map(({taskId,group,trial,directory,startedAt,reason})=>({taskId,group,trial,directory,startedAt,reason,usage:null})),
    progress:protocol.groups.map(group=>{
      const trials=states.filter(state=>state.group === group.id),completed=rows.filter(row=>row.group === group.id);
      const count=status=>trials.filter(state=>state.status === status).length;
      return {group:group.id,scheduled:trials.length,completed:count("completed"),interrupted:count("interrupted"),pending:count("pending"),usageUnknown:count("interrupted")+completed.filter(row=>protocol.summaryVersion===3 ? !hasCompleteUsage(row.run.usage) : !row.run.usage).length};
    }),groups:rows.length?summarize(rows,{extended:true,legacyDuration:protocol.summaryVersion===undefined}):[]};
}
