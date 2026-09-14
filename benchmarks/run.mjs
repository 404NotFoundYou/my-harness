import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { tasks } from "./tasks.mjs";
import { budget, groups, hash, runCase, saveJson, summarize } from "./runner.mjs";
import { codexDriver } from "./codex-driver.mjs";
import { sourceSnapshot } from "../.ai-harness/src/snapshot.mjs";

const options = Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
for(const key of ["--cli","--weak","--strong","--out"]) if(!options[key])throw new Error(`Missing ${key}`);
const outputDirectory=path.resolve(options["--out"]);
await mkdir(outputDirectory); // Never replace an earlier experiment.
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const source=await sourceSnapshot(sourceRoot);
const matrix=groups(options["--weak"],options["--strong"]);
await saveJson(path.join(outputDirectory,"protocol.json"),{schemaVersion:1,mode:"real",createdAt:new Date().toISOString(),budget,groups:matrix,source:source.digest,
  tasks:tasks.map(task=>({id:task.id,split:task.split,taskDigest:hash(JSON.stringify(task.files)),judgeDigest:hash(JSON.stringify(task.cases))})),
  limitations:["模型名按现有CLI与服务配置记录，不能验证自定义服务实际后端权重。","单次三题先导不支持统计显著性或通用能力等价结论。","固定同一墙钟与工具预算；token为CLI用量，未换算货币费用。"]});
const results=[];
for(let index=0;index<tasks.length;index++){
  for(let offset=0;offset<matrix.length;offset++){
    const task=tasks[index],group=matrix[(index+offset)%matrix.length];
    const directory=path.join(outputDirectory,`${task.id}-${group.id}`);
    console.log(JSON.stringify({event:"started",task:task.id,group:group.id,model:group.model}));
    const result=await runCase({task,group,sourceRoot,outputDirectory:directory,driver:codexDriver(options["--cli"])});
    results.push(result);
    console.log(JSON.stringify({event:"finished",task:task.id,group:group.id,functional:result.grade.ok,success:result.success,timeout:result.run.timedOut,durationMs:result.run.durationMs}));
    await saveJson(path.join(outputDirectory,"summary.json"),{mode:"real",complete:false,results:results.map(row=>({taskId:row.taskId,group:row.group,success:row.success,functionalPassed:row.grade.ok})),groups:summarize(results)});
  }
}
const sourceAfter=(await sourceSnapshot(sourceRoot)).digest;
const complete=sourceAfter===source.digest;
await saveJson(path.join(outputDirectory,"summary.json"),{mode:"real",complete,sourceBefore:source.digest,sourceAfter,
  results:results.map(row=>({taskId:row.taskId,group:row.group,success:row.success,functionalPassed:row.grade.ok})),groups:summarize(results)});
if(!complete)throw new Error("Harness source changed during the experiment; results must not be presented as a fixed-version comparison");
console.log(JSON.stringify({event:"complete",groups:summarize(results)}));
