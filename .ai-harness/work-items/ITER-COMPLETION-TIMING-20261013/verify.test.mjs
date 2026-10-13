import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { auditExperiment } from "../../../benchmarks/audit.mjs";
import { createComparisonReport } from "../../../benchmarks/report.mjs";
const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,"../../..");
const historical=path.join(root,".ai-harness/work-items/MODEL-PAIRED-20261013");
async function hashes(){
  const values={};for(const entry of await readdir(historical,{recursive:true})){
    const file=entry.replaceAll("\\","/"),target=path.join(historical,file);
    if((await lstat(target)).isFile())values[file]=createHash("sha256").update(await readFile(target)).digest("hex");
  }return values;
}
test("historical observations stay byte-identical and missing lifecycle points cannot become measured zero",async()=>{
  const original=JSON.parse(await readFile(path.join(directory,"historical-hashes.json"),"utf8"));
  assert.deepEqual(await hashes(),original,"diagnosis cannot rewrite the six original trials or conclusions");
  const audit=await auditExperiment(path.join(historical,"pilot"));assert.equal(audit.valid,true);assert.equal(audit.samples,6);
  const report=await createComparisonReport({outputDirectory:path.join(historical,"pilot")});assert.equal(report.ok,true);
  const rows=report.pairs.flatMap(pair=>["baseline","harness"].map(group=>{
    const row=pair[group],ending=row.timing.completion;
    for(const field of ["firstProtocolEventMs","terminalEventMs","processExitMs","processCloseMs","exitAfterTerminalMs","closeAfterExitMs"])
      assert.equal(ending[field],null,"the old pilot did not measure "+field);
    const source=audit.rows.find(value=>value.taskId===pair.taskId&&value.trial===pair.trial&&value.group===`weak-${group}`);
    const starts=(source.run.timing?.spans||[]).map(span=>span.startMs);
    const firstToolStartMs=starts.length?Math.min(...starts):null;
    return {task:pair.taskId,trial:pair.trial,group,firstToolStartMs,functional:row.functional,fullDelivery:row.fullDelivery,censored:row.censored,
      terminalObserved:row.terminalObserved,durationMs:row.measurements.durationMs,toolActiveMs:row.timing.toolActiveMs,otherElapsedMs:row.timing.otherElapsedMs,...ending};
  }));
  assert.equal(rows.find(row=>row.task==="csv"&&row.group==="baseline").afterLastToolMs,43214);
  assert.equal(rows.find(row=>row.task==="events"&&row.group==="harness").afterLastToolMs,18950);
  assert.equal(rows.filter(row=>row.fullDelivery).length,4);
  const protocol=JSON.parse(await readFile(path.join(historical,"pilot/protocol.json"),"utf8"));
  await writeFile(path.join(directory,"historical-timeline.json"),JSON.stringify({source:protocol.source,samples:rows.length,rows,
    limitation:"原记录未保存四锚点；末尾间隔是最后工具接收事件到观测终止，不能归因于纯模型或网络，也不代表未截断完成耗时。"},null,2)+"\n");
  assert.deepEqual(await hashes(),original,"new reports must remain separate from archived evidence");
});
