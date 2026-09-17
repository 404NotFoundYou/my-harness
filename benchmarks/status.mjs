import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { cliIdentity, validateExperimentProtocol } from "./experiment.mjs";
import { readExecution, readExecutionLedger } from "./execution.mjs";
import { readExperimentFile } from "./audit-trial.mjs";
import { sourceSnapshot } from "../.ai-harness/src/snapshot.mjs";
import { inspectLock } from "../.ai-harness/src/locking.mjs";
import { redact } from "../.ai-harness/src/evidence.mjs";

const sourceDirectory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const previewLimit=20;
const safeLocks=["free","stale"];

// Diagnostics deliberately omit exception messages: parsers/assertions may echo candidate content.
async function capture(action) {
  try{return {value:await action()};}catch(error){return {error:error.code || error.name || "READ_FAILED"};}
}

function sanitized(value) {
  if(typeof value === "string")return redact(value);
  if(Array.isArray(value))return value.map(sanitized);
  if(value&&typeof value === "object")return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,sanitized(entry)]));
  return value;
}

function progress(protocol,ledger) {
  const count=trials=>Object.fromEntries(["pending","started","completed","interrupted"].map(status=>[status,trials.filter(row=>row.status===status).length]));
  const trials=ledger.trials.map((state,index)=>({...protocol.schedule[index],...state}));
  return {scheduled:trials.length,totals:count(trials),groups:protocol.groups.map(group=>({group:group.id,...count(trials.filter(row=>row.group===group.id))})),
    trials:trials.slice(0,previewLimit),omittedTrials:Math.max(0,trials.length-previewLimit)};
}

export async function inspectExperiment({sourceRoot=sourceDirectory,outputDirectory,cliPath,driverIdentity}={}) {
  const report={readOnly:true,integrity:"unverified",protocol:null,observed:null,recoveryPreview:null,
    source:{status:"unverified"},driver:{status:"unverified"},lock:{status:"unknown"},
    observation:{startedAt:new Date().toISOString(),stable:false},blockers:[],
    resume:{canResume:false,remainingCalls:null,validationRequiredOnExecution:true,lockRecoveryRequired:false}};
  const block=(code,message)=>report.blockers.push({code,message});
  let directory,before,sourceBefore,driverBefore,readDriver;
  const controls=async()=>({protocol:await capture(()=>readExperimentFile(directory,"protocol.json")),execution:await capture(()=>readExperimentFile(directory,"execution.json"))});
  const lock=()=>capture(()=>inspectLock(path.join(directory,".experiment.lock")));
  try{
    directory=await realpath(outputDirectory);
    before={lock:await lock(),...await controls()};
    report.lock=before.lock.value || {status:"unknown"};
    if(before.protocol.error)throw new Error("Protocol unavailable");
    const protocol=JSON.parse(before.protocol.value.toString("utf8"));
    if([1,2,3].includes(protocol?.schemaVersion)){
      report.integrity="unsupported";
      block("UNSUPPORTED_PROTOCOL","旧协议只支持原有审计，不能预览续跑。");
    }else{
      validateExperimentProtocol(protocol);
      const {schemaVersion,mode,suite,client,comparison,repetitions,groups,budget,createdAt}=protocol;
      report.protocol={schemaVersion,mode,suite,client,comparison,repetitions,groups,budget,createdAt,scheduled:protocol.schedule.length};
      sourceBefore=await capture(async()=>(await sourceSnapshot(sourceRoot)).digest);
      report.source={status:sourceBefore.error?"unverified":sourceBefore.value===protocol.source?"matched":"mismatch",expected:protocol.source,current:sourceBefore.value ?? null};
      if(report.source.status!=="matched")block(sourceBefore.error?"SOURCE_UNVERIFIED":"SOURCE_MISMATCH","当前源码无法确认与冻结源码一致。");
      if(cliPath !== undefined)readDriver=()=>cliIdentity(cliPath);
      else if(mode === "simulated"&&driverIdentity !== undefined)readDriver=async()=>structuredClone(driverIdentity);
      if(readDriver){
        driverBefore=await capture(readDriver);
        report.driver={status:driverBefore.error?"unverified":isDeepStrictEqual(driverBefore.value,protocol.driverIdentity)?"matched":"mismatch",basis:cliPath !== undefined?"explicit-cli":"caller-declared"};
      }
      if(report.driver.status!=="matched")block(report.driver.status==="mismatch"?"DRIVER_MISMATCH":"DRIVER_UNVERIFIED","需显式确认与冻结驱动一致的身份；状态检查不执行客户端。");
      if(before.execution.error)throw new Error("Execution unavailable");
      report.observed=progress(protocol,await readExecutionLedger(directory,protocol));
      if(safeLocks.includes(report.lock.status)){
        const recovered=await readExecution(directory,protocol);
        report.recoveryPreview={...progress(protocol,recovered.ledger),needed:recovered.changed,complete:recovered.ledger.trials.every(row=>row.status==="completed")};
        report.integrity="verified";
      }else block("LOCK_BLOCKED","实验存在活动、异机或无法确认的锁，只展示记录结构，未审计结果或推导恢复。");
    }
  }catch{
    report.integrity="invalid";
    block("INVALID_EVIDENCE","实验记录缺失、结构无效或证据不一致；未修改记录。");
  }
  // Recheck on both success and failure. A moving writer is not evidence of persistent corruption.
  let identitiesStable=true;
  if(sourceBefore){
    const after=await capture(async()=>(await sourceSnapshot(sourceRoot)).digest);
    if(!isDeepStrictEqual(sourceBefore,after)){
      report.source={...report.source,status:"unverified",current:after.value ?? null};
      identitiesStable=false;
      report.integrity=report.integrity==="invalid"?"invalid":"unverified";
      block("SOURCE_CHANGED","检查期间源码发生变化或无法重新读取。");
    }
  }
  if(driverBefore){
    const after=await capture(readDriver);
    if(!isDeepStrictEqual(driverBefore,after)){
      report.driver.status="unverified";
      identitiesStable=false;
      report.integrity=report.integrity==="invalid"?"invalid":"unverified";
      block("DRIVER_CHANGED","检查期间显式驱动身份发生变化或无法重新读取。");
    }
  }
  if(before){
    const after={...await controls(),lock:await lock()};
    const controlsStable=isDeepStrictEqual(before,after);
    report.observation.stable=controlsStable&&identitiesStable;
    report.lock=after.lock.value || {status:"unknown"};
    if(!controlsStable){
      report.integrity="unverified";
      report.recoveryPreview=null;
      report.blockers=report.blockers.filter(row=>row.code!=="INVALID_EVIDENCE");
      block("CONCURRENT_CHANGE","读取期间协议、执行记录或锁发生变化；请在执行者停止后重新检查。");
    }
  }
  report.resume.lockRecoveryRequired=report.lock.status==="stale";
  report.resume.canResume=report.integrity==="verified"&&report.observation.stable&&report.source.status==="matched"&&report.driver.status==="matched"&&safeLocks.includes(report.lock.status);
  if(report.resume.canResume)report.resume.remainingCalls=report.recoveryPreview.totals.pending;
  report.observation.finishedAt=new Date().toISOString();
  return sanitized(report);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options={};
    for(let index=2;index<process.argv.length;index++){
      const key=process.argv[index],value=process.argv[++index];
      if(!["--out","--cli"].includes(key)||Object.hasOwn(options,key)||!value||value.startsWith("--"))throw new Error("Invalid arguments");
      options[key]=value;
    }
    if(!options["--out"])throw new Error("Missing output directory");
    const report=await inspectExperiment({outputDirectory:options["--out"],cliPath:options["--cli"]});
    console.log(JSON.stringify(report,null,2));
    process.exitCode=report.resume.canResume?0:report.integrity==="invalid"?1:2;
  }catch{
    console.error(JSON.stringify({readOnly:true,error:"参数无效。用法：node benchmarks/status.mjs --out <实验目录> [--cli <CLI实际文件路径>]"}));
    process.exitCode=1;
  }
}
