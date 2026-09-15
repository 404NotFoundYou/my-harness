import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "../../../benchmarks/runner.mjs";
import { codexDriver } from "../../../benchmarks/codex-driver.mjs";
const directory=path.dirname(fileURLToPath(import.meta.url));
const entry="src/scale.mjs";
const task={id:"client-smoke",split:"smoke",entry,name:"scale",cases:[
 ["positive","assert.equal(f(4),8);"],["negative","assert.equal(f(-3),-6);"],["zero","assert.equal(f(0),0);"]],
 files:{
  [entry]:"export function scale(value) { return value; }\n",
  "src/caller.mjs":'import { scale } from "./scale.mjs"; export const present = value => ({ result: scale(value) });\n',
  "test/public.test.mjs":'import test from "node:test"; import assert from "node:assert/strict"; import { scale } from "../src/scale.mjs"; test("new doubling behavior",()=>assert.equal(scale(2),4));\n',
  "TASK.md":"新需求：把scale的原样返回改为返回数值的两倍，保持caller接口兼容。只允许修改src/scale.mjs和新增test/extra.test.mjs。用预备的task.json执行begin --spec；完成实际验证与审查，再按guide建议finish并check --ci。无需安装依赖、网络、Git提交或向用户提问。\n",
  "task.json":JSON.stringify({schemaVersion:1,id:"CLIENT-SMOKE",type:"ITERATION",title:"double numeric values",references:["TASK.md"],acceptance:["numeric input doubles and caller stays compatible"],authorizationSource:"用户已授权的本地临时客户端验证任务",risk:"low",approach:"update the local pure function",databaseEvidence:"no persistence",writeScopes:[entry,"test/extra.test.mjs"],verification:[{command:"node",args:["--test","test/public.test.mjs"]}],docsImpact:["N/A: no documentation change"]})
 }};
const result=await runCase({task,group:{id:"weak-harness",harness:true,model:"gpt-5.6-luna"},sourceRoot:process.cwd(),outputDirectory:path.join(directory,"codex-smoke"),driver:codexDriver("D:/Program Files/nodejs/node_global/node_modules/@openai/codex/bin/codex.js"),runBudget:{timeoutMs:120000,maxToolCalls:35,reasoning:"medium"}});
console.log(JSON.stringify({success:result.success,functional:result.grade.ok,workflow:result.workflow,timing:result.run.timing,usage:result.run.usage}));if(!result.success)process.exitCode=1;
