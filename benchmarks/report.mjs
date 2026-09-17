import path from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { auditExperiment } from "./audit.mjs";
import { readExperimentFile } from "./audit-trial.mjs";
import { readExecutionLedger } from "./execution.mjs";
import { validateExperimentProtocol } from "./experiment.mjs";
import { hash } from "./runner.mjs";
import { trialStatistics } from "./statistics.mjs";
import { redactProtocolValue } from "./protocol.mjs";
import { inspectLock } from "../.ai-harness/src/locking.mjs";

const metrics=["durationMs","toolCalls","inputTokens","outputTokens"];
const outcomes=["functional","sharedDelivery","fullDelivery"];
const messages={INVALID_EVIDENCE:"实验证据缺失、损坏或不一致。",INVALID_MEASUREMENT:"记录包含非法度量，不能据此比较收益。",
  UNSUPPORTED_PROTOCOL:"报告仅支持已完成的v4实验。",INCOMPLETE_EXPERIMENT:"实验尚未完整完成，请先查看status及中断记录。",
  LOCK_BLOCKED:"实验存在活动、异机或无法确认的锁。",CONCURRENT_CHANGE:"读取期间证据或锁发生变化，未生成比较结果。"};
class ReportError extends Error {constructor(code){super(messages[code]);this.code=code;}}
function requireValue(condition,code="INVALID_EVIDENCE"){if(!condition)throw new ReportError(code);}
function measurement(value,integer=false){
  if(value===undefined||value===null)return null;
  requireValue(Number.isFinite(value)&&value>=0&&(!integer||Number.isSafeInteger(value)),"INVALID_MEASUREMENT");
  return value;
}
function median(values){
  if(!values.length)return null;
  const sorted=values.toSorted((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:sorted[middle-1]/2+sorted[middle]/2;
}
function normalizedTiming(value){
  if(value===undefined||value===null)return null;
  requireValue(typeof value==="object"&&!Array.isArray(value),"INVALID_MEASUREMENT");
  requireValue(value.basis===undefined||value.basis==="local-event-receive-time","INVALID_MEASUREMENT");
  requireValue(value.categories===undefined||value.categories===null||(typeof value.categories==="object"&&!Array.isArray(value.categories)),"INVALID_MEASUREMENT");
  const categories=value.categories===undefined||value.categories===null?null:Object.entries(value.categories).map(([category,entry])=>{
    requireValue(!Object.hasOwn(Object.prototype,category),"INVALID_MEASUREMENT");
    requireValue(entry&&typeof entry==="object"&&!Array.isArray(entry),"INVALID_MEASUREMENT");
    const calls=measurement(entry.calls,true),activeMs=measurement(entry.activeMs);
    requireValue(calls!==null&&activeMs!==null,"INVALID_MEASUREMENT");
    return {category,calls,activeMs};
  });
  return {basis:value.basis??null,toolActiveMs:measurement(value.toolActiveMs),otherElapsedMs:measurement(value.otherElapsedMs),categories};
}
function trial(row,entry){
  requireValue([row.grade.ok,row.scope.ok,row.run.completed,row.success].every(value=>typeof value==="boolean"));
  requireValue(typeof row.falseCompletion==="boolean","INVALID_MEASUREMENT");
  for(const field of ["timedOut","toolLimit","protocolSuccess"])
    requireValue(row.run[field]==null||typeof row.run[field]==="boolean","INVALID_MEASUREMENT");
  if(row.run.unparsedLines!=null)measurement(row.run.unparsedLines,true);
  requireValue(row.run.errors==null||Array.isArray(row.run.errors),"INVALID_MEASUREMENT");
  requireValue(row.run.error==null||typeof row.run.error==="string","INVALID_MEASUREMENT");
  requireValue(row.run.exitCode==null||Number.isSafeInteger(row.run.exitCode),"INVALID_MEASUREMENT");
  requireValue(row.run.final?.completed==null||typeof row.run.final.completed==="boolean","INVALID_MEASUREMENT");
  if(row.group==="weak-harness")requireValue(row.workflow?.ok==null||typeof row.workflow.ok==="boolean","INVALID_MEASUREMENT");
  const usage=row.run.usage;
  requireValue(usage===undefined||usage===null||(typeof usage==="object"&&!Array.isArray(usage)),"INVALID_MEASUREMENT");
  const timing=normalizedTiming(row.run.timing);
  const failures=[];
  if(!row.grade.ok)failures.push("functional-failed");
  if(!row.scope.ok)failures.push("scope-failed");
  if(row.run.timedOut)failures.push("timeout");
  if(row.run.toolLimit)failures.push("tool-limit");
  if(row.run.error||(row.run.exitCode!==undefined&&row.run.exitCode!==null&&row.run.exitCode!==0))failures.push("execution-failed");
  if(trialStatistics([row]).protocolFailures)failures.push("protocol-failed");
  if(!row.run.completed)failures.push("run-incomplete");
  if(row.group==="weak-harness"&&!row.workflow?.ok)failures.push("workflow-incomplete");
  if(row.falseCompletion)failures.push("false-completion");
  const censored=row.run.timedOut===true||row.run.toolLimit===true;
  return {resultFile:`${entry.directory}/result.json`,functional:row.grade.ok,sharedDelivery:Boolean(row.run.completed&&row.scope.ok&&row.grade.ok),fullDelivery:row.success,
    failures,censored,censorUnknown:!censored&&(row.run.timedOut==null||row.run.toolLimit==null),
    measurements:{durationMs:measurement(row.run.durationMs),toolCalls:measurement(row.run.toolCalls,true),inputTokens:measurement(usage?.input_tokens,true),outputTokens:measurement(usage?.output_tokens,true)},
    timing};
}
function timingSummary(trials){
  const known=trials.filter(row=>row.timing?.categories!==null&&row.timing?.categories!==undefined),categories=new Map();
  for(const row of known)for(const entry of row.timing.categories){
    const total=categories.get(entry.category)||{category:entry.category,calls:0,activeMs:0};
    total.calls+=entry.calls;total.activeMs+=entry.activeMs;
    requireValue(Number.isSafeInteger(total.calls)&&Number.isFinite(total.activeMs),"INVALID_MEASUREMENT");
    categories.set(entry.category,total);
  }
  return {observedSamples:known.length,unknownSamples:trials.length-known.length,categories:[...categories.values()]};
}
function compare(protocol,rows){
  const key=entry=>`${entry.taskId}:${entry.group}:${entry.trial}`;
  const byKey=new Map(rows.map(row=>[key(row),row]));
  requireValue(byKey.size===rows.length&&rows.length===protocol.schedule.length);
  const trials=new Map(protocol.schedule.map(entry=>{const row=byKey.get(key(entry));requireValue(row);return [key(entry),trial(row,entry)];}));
  const pairs=protocol.schedule.filter(entry=>entry.group==="weak-baseline").map(entry=>{
    const baseline=trials.get(key(entry)),harness=trials.get(key({...entry,group:"weak-harness"}));requireValue(baseline&&harness);
    return {taskId:entry.taskId,trial:entry.trial,split:protocol.tasks.find(task=>task.id===entry.taskId).split,baseline,harness,
      delta:Object.fromEntries(metrics.map(metric=>[metric,baseline.measurements[metric]===null||harness.measurements[metric]===null?null:harness.measurements[metric]-baseline.measurements[metric]]))};
  });
  const outcomeTotals=Object.fromEntries(outcomes.map(outcome=>{
    const counts={baselineOnly:0,harnessOnly:0,bothPass:0,bothFail:0};
    for(const pair of pairs)counts[pair.baseline[outcome]?pair.harness[outcome]?"bothPass":"baselineOnly":pair.harness[outcome]?"harnessOnly":"bothFail"]++;
    return [outcome,counts];
  }));
  const measurements=Object.fromEntries(metrics.map(metric=>{
    const values=pairs.map(pair=>pair.delta[metric]).filter(value=>value!==null);
    return [metric,{pairedSamples:values.length,unknownPairs:pairs.length-values.length,medianDelta:median(values)}];
  }));
  const sides=["baseline","harness"];
  return {pairs,summary:{pairs:pairs.length,censoredPairs:pairs.filter(pair=>pair.baseline.censored||pair.harness.censored).length,
    unknownTruncationPairs:pairs.filter(pair=>!pair.baseline.censored&&!pair.harness.censored&&(pair.baseline.censorUnknown||pair.harness.censorUnknown)).length,
    outcomes:outcomeTotals,measurements,
    failures:Object.fromEntries(sides.map(side=>{
      const counts={};for(const pair of pairs)for(const failure of pair[side].failures)counts[failure]=(counts[failure]||0)+1;return [side,counts];
    })),timings:Object.fromEntries(sides.map(side=>[side,timingSummary(pairs.map(pair=>pair[side]))]))}};
}

export async function createComparisonReport({outputDirectory}={}){
  let directory,initialLock,value,failure,stage="open";
  const files=new Map();
  async function readEvidence(relative){
    let bytes;
    try{bytes=await readExperimentFile(directory,relative);}catch(error){
      if(error.code!=="ENOENT")throw error;
      if(files.has(relative)&&files.get(relative)!==null)throw new ReportError("CONCURRENT_CHANGE");
      files.set(relative,null);throw error;
    }
    const digest=hash(bytes);
    if(files.has(relative)&&files.get(relative)!==digest)throw new ReportError("CONCURRENT_CHANGE");
    files.set(relative,digest);return bytes;
  }
  try{
    directory=await realpath(outputDirectory);
    initialLock=await inspectLock(path.join(directory,".experiment.lock"));
    requireValue(["free","stale"].includes(initialLock.status),"LOCK_BLOCKED");
    stage="protocol";
    const protocol=JSON.parse((await readEvidence("protocol.json")).toString("utf8"));
    requireValue(![1,2,3].includes(protocol?.schemaVersion),"UNSUPPORTED_PROTOCOL");validateExperimentProtocol(protocol);
    stage="execution";
    const ledger=await readExecutionLedger(directory,protocol,{readEvidence});
    requireValue(ledger.trials.every(row=>row.status==="completed"),"INCOMPLETE_EXPERIMENT");
    const summary=JSON.parse((await readEvidence("summary.json")).toString("utf8"));
    requireValue(summary.complete!==false,"INCOMPLETE_EXPERIMENT");
    stage="measurements";
    for(const entry of protocol.schedule){
      const row=JSON.parse((await readEvidence(`${entry.directory}/result.json`)).toString("utf8"));
      trial(row,entry);
    }
    stage="audit";
    const audited=await auditExperiment(directory,{readEvidence});
    stage="comparison";
    value={ok:true,readOnly:true,schemaVersion:1,mode:protocol.mode,source:protocol.source,protocolSha256:files.get("protocol.json"),
      experiment:{suite:protocol.suite,client:protocol.client,comparison:protocol.comparison,repetitions:protocol.repetitions,groups:protocol.groups,budget:protocol.budget,createdAt:protocol.createdAt,samples:audited.samples},
      direction:"weak-harness minus weak-baseline",...compare(protocol,audited.rows),
      limitations:["仅描述本次冻结实验；同题重复不是独立任务，不能据此证明通用能力或因果收益。","共同交付条件对两组相同；完整交付另含Harness流程门禁。strong-reference不计入配对分母。",
        "耗时是观测区间；超时/工具预算截断不表示更快完成。缺失度量为未知，Token不换算货币费用。","失败类型可重叠，仅反映记录中的条件，不等于模型或网络根因。",
        "工具类别区间可重叠，不相加为总耗时；其余耗时包含网络、启动和收尾，不等于纯推理耗时。","审计核验记录内部一致性；本报告不启动模型、不验证当前客户端或返回后的文件状态。"]};
  }catch(error){failure=error instanceof ReportError?error:new ReportError("INVALID_EVIDENCE");}
  // Always re-read actual files, including absent optional evidence and failed-audit paths.
  for(const [relative,digest]of files){
    try{const bytes=await readExperimentFile(directory,relative).catch(error=>{if(error.code==="ENOENT")return null;throw error;});
      if((bytes===null?null:hash(bytes))!==digest)failure=new ReportError("CONCURRENT_CHANGE");
    }catch{failure=new ReportError("CONCURRENT_CHANGE");}
  }
  if(initialLock){
    try{if(!isDeepStrictEqual(initialLock,await inspectLock(path.join(directory,".experiment.lock"))))failure=new ReportError("CONCURRENT_CHANGE");}
    catch{failure=new ReportError("CONCURRENT_CHANGE");}
  }
  if(failure)return {ok:false,readOnly:true,error:{code:failure.code,message:failure.message,stage}};
  return redactProtocolValue(value);
}

function markdown(value){
  const escape=text=>String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/[\\`*_[\]{}()!|#]/g,"\\$&").replace(/[\r\n]+/g," ");
  const number=value=>value===null?"未知":String(value);
  const label={functional:"功能通过",sharedDelivery:"共同交付",fullDelivery:"完整交付"};
  const names={durationMs:"观测区间差(ms)",toolCalls:"工具次数差",inputTokens:"输入Token差",outputTokens:"输出Token差"};
  const lines=["# 实验收益对照报告","",`模式：${escape(value.mode)}；题集：${escape(value.experiment.suite)}；客户端：${escape(value.experiment.client)}；样本：${value.experiment.samples}；配对：${value.summary.pairs}。`,
    `冻结源码：${value.source}`,`模型：${escape(value.experiment.groups.find(group=>group.id==="weak-baseline").model)}`,
    `差值方向：Harness − baseline；确认截断的配对：${value.summary.censoredPairs}；截断状态未知的配对：${value.summary.unknownTruncationPairs}。`,"","| 口径 | 仅baseline通过 | 仅Harness通过 | 都通过 | 都失败 |","| --- | ---: | ---: | ---: | ---: |"];
  for(const outcome of outcomes){const row=value.summary.outcomes[outcome];lines.push(`| ${label[outcome]} | ${row.baselineOnly} | ${row.harnessOnly} | ${row.bothPass} | ${row.bothFail} |`);}
  lines.push("","| 度量 | 有效配对 | 未知配对 | 每对差值的中位数 |","| --- | ---: | ---: | ---: |");
  for(const metric of metrics){const row=value.summary.measurements[metric];lines.push(`| ${names[metric]} | ${row.pairedSamples} | ${row.unknownPairs} | ${number(row.medianDelta)} |`);}
  lines.push("","## 逐题配对","","| 题目 / 轮次 | 组别与证据 | 功能 / 共同 / 完整 | 观测ms / 差值 | 工具次数 / 差值 | 输入 / 输出Token或差值 | 失败类型 |","| --- | --- | --- | ---: | ---: | --- | --- |");
  for(const pair of value.pairs){
    for(const side of ["baseline","harness"]){const row=pair[side];
      lines.push(`| ${escape(pair.taskId)} / ${pair.trial} | [${side}](<./${row.resultFile}>) | ${outcomes.map(key=>row[key]?"通过":"失败").join(" / ")} | ${number(row.measurements.durationMs)}${row.censored?"（截断）":row.censorUnknown?"（截断未知）":""} | ${number(row.measurements.toolCalls)} | ${number(row.measurements.inputTokens)} / ${number(row.measurements.outputTokens)} | ${row.failures.join(", ")||"无"} |`);
    }
    lines.push(`| ${escape(pair.taskId)} / ${pair.trial} | 差值(Harness−baseline) | - | ${number(pair.delta.durationMs)} | ${number(pair.delta.toolCalls)} | ${number(pair.delta.inputTokens)} / ${number(pair.delta.outputTokens)} | - |`);
  }
  lines.push("","## 工具阶段","","| 组别 / 类别 | 次数 | 活跃ms | 有计时 / 未知样本 |","| --- | ---: | ---: | --- |");
  for(const side of ["baseline","harness"]){const timing=value.summary.timings[side];
    if(!timing.categories.length)lines.push(`| ${side} / 未知 | 未知 | 未知 | ${timing.observedSamples} / ${timing.unknownSamples} |`);
    for(const entry of timing.categories)lines.push(`| ${side} / ${escape(entry.category)} | ${entry.calls} | ${entry.activeMs} | ${timing.observedSamples} / ${timing.unknownSamples} |`);
  }
  lines.push("","## 解释边界","",...value.limitations.map(text=>`- ${escape(text)}`),"");return lines.join("\n");
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const options={};
    for(let index=2;index<process.argv.length;index++){
      const key=process.argv[index],value=process.argv[++index];
      if(!["--out","--format"].includes(key)||Object.hasOwn(options,key)||!value||value.startsWith("--"))throw new Error("Invalid arguments");options[key]=value;
    }
    const format=options["--format"]||"json";
    if(!options["--out"]||!["json","markdown"].includes(format))throw new Error("Invalid arguments");
    const value=await createComparisonReport({outputDirectory:options["--out"]});
    if(!value.ok){console.error(JSON.stringify(value));process.exitCode=["INVALID_EVIDENCE","INVALID_MEASUREMENT"].includes(value.error.code)?1:2;}
    else console.log(format==="json"?JSON.stringify(value,null,2):markdown(value));
  }catch{console.error(JSON.stringify({ok:false,readOnly:true,error:{code:"INVALID_ARGUMENTS",message:"用法：node benchmarks/report.mjs --out <实验目录> [--format json|markdown]"}}));process.exitCode=1;}
}
