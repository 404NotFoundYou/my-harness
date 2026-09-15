import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceSnapshot } from "../../src/snapshot.mjs";
import { redact } from "../../src/evidence.mjs";
const directory=path.dirname(fileURLToPath(import.meta.url));
const attempt=process.argv[2] || "1";
const output=path.join(directory,`review-${attempt}.json`);
const before=await sourceSnapshot(process.cwd());
const schema={type:"object",properties:{verdict:{enum:["pass","changes_requested"]},findings:{type:"array",items:{type:"object",properties:{file:{type:"string"},line:{type:"integer"},issue:{type:"string"},reproduction:{type:"string"}},required:["file","line","issue","reproduction"],additionalProperties:false}},limitations:{type:"array",items:{type:"string"}}},required:["verdict","findings","limitations"],additionalProperties:false};
await writeFile(path.join(directory,"review-schema.json"),JSON.stringify(schema));
let prompt="请独立只读审查本轮相对afb485e的改动，不修改文件或创建工作项，主任务维护高风险R1记录。重点：begin结构化输入与逗号诊断不扩大写入授权；finish可从中间状态继续但不能覆盖失败审查、复用旧源证据或跳过独立门禁，DONE重复调用不写记录；policyRoutingVersion兼容旧终态；上下文指纹不把截断当完整；三客户端流解析不伪造成功，工具时间不冒充推理时间。已有定向26项通过，全量另由主任务执行。请仅报告可确认的本轮实现缺陷，给具体触发步骤；不无限扩大到未改动模块或仓库所有者恶意篡改。\n";
if(attempt!=="1")prompt+=await readFile(path.join(directory,"review-followup.txt"),"utf8");
for(const file of (attempt==="1"?[".ai-harness/src/input.mjs",".ai-harness/src/completion.mjs",".ai-harness/src/compact.mjs",".ai-harness/src/policy-routing.mjs",".ai-harness/src/context.mjs",".ai-harness/src/guide.mjs",".ai-harness/src/verification.mjs","benchmarks/client-drivers.mjs","benchmarks/timing.mjs"]:attempt==="3"?["benchmarks/client-drivers.mjs","benchmarks/tests/runner.test.mjs"]:[".ai-harness/src/input.mjs",".ai-harness/src/completion.mjs",".ai-harness/src/compact.mjs",".ai-harness/src/policy-routing.mjs","benchmarks/client-drivers.mjs","benchmarks/timing.mjs"])){
 const content=await readFile(file,"utf8");prompt+=`\nFILE ${file}\n`+content.split(/\r?\n/).map((line,i)=>`${i+1}: ${line}`).join("\n");
}
const childResult=await new Promise(resolve=>{
 const args=["D:/Program Files/nodejs/node_global/node_modules/@openai/codex/bin/codex.js","exec","--ephemeral","--json","--color","never","--sandbox","read-only","-C",process.cwd(),"-m","gpt-5.6-sol","-c",attempt==="1"?'model_reasoning_effort="high"':'model_reasoning_effort="medium"',"--output-schema",path.join(directory,"review-schema.json"),"-o",output,"-"];
 const child=spawn(process.execPath,args,{windowsHide:true,stdio:["pipe","pipe","pipe"]});let stdout="",stderr="",timedOut=false;const start=Date.now();
 const timer=setTimeout(()=>{timedOut=true;if(child.pid&&child.exitCode===null)spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});},480000);
 child.stdout.on("data",chunk=>{stdout+=chunk;});child.stderr.on("data",chunk=>{stderr+=chunk;});
 child.once("error",error=>{clearTimeout(timer);resolve({exitCode:1,error:redact(error.message)});});
 child.once("close",exitCode=>{clearTimeout(timer);resolve({exitCode,timedOut,durationMs:Date.now()-start,stdout:redact(stdout),stderr:redact(stderr)});});child.stdin.end(prompt);
});
const after=await sourceSnapshot(process.cwd());
await writeFile(path.join(directory,`review-${attempt}-events.jsonl`),childResult.stdout||"");
const result={...childResult,stdout:undefined,sourceBefore:before.digest,sourceAfter:after.digest,unchanged:before.digest===after.digest};
await writeFile(path.join(directory,`review-${attempt}-run.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,stderr:undefined}));if(result.exitCode!==0||!result.unchanged)process.exitCode=1;
