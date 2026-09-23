import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tasks } from "../tasks.mjs";
import { projectTasks } from "../project-tasks.mjs";
import { groups, participantPrompt, runCase } from "../runner.mjs";
import { taskManifest } from "../task-contract.mjs";
import { loadBeginSpec } from "../../.ai-harness/src/input.mjs";
import { loadPlan, loadWorkItem } from "../../.ai-harness/src/workflow.mjs";

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const specPath=".ai-harness/work-items/benchmark-begin-spec.json";
const read=async file=>JSON.parse(await readFile(file,"utf8"));
const synthetic=()=>({mode:"simulated",client:"codex",completed:true,final:{completed:true,summary:"fixture",tests:[]},durationMs:1,usage:null});
async function temporary(){return mkdtemp(path.join(tmpdir(),"ai-harness-spec-guidance-"));}
async function cleanup(directory){assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith("ai-harness-spec-guidance-"));await rm(directory,{recursive:true,force:true});}
function cli(root,args,expected=0){const result=spawnSync(process.execPath,[".ai-harness/bin/harness.mjs",...args],{cwd:root,shell:false,windowsHide:true,encoding:"utf8",env:{...process.env,NODE_TEST_CONTEXT:undefined}});assert.equal(result.status,expected,result.stderr||result.stdout);return JSON.parse(result.stdout||result.stderr);}

test("core Harness group gets exact public paths/checks while risk and approach remain model judgments",async()=>{
  const directory=await temporary();
  try{
    for(const task of tasks){
      const manifest=taskManifest(task);
      const row=await runCase({task,group:groups("fixture","reference")[1],sourceRoot,outputDirectory:path.join(directory,task.id),
        driver:async({root,outputDirectory})=>{
          const instructions=await readFile(path.join(root,"AGENTS.md"),"utf8");
          assert.match(instructions,/benchmark-begin-spec\.json/);
          assert.match(instructions,/不要修改.*benchmark-begin-spec\.json/);
          assert.match(instructions,/--risk.*--approach/);
          assert.match(instructions,/项目相对路径/);
          assert.match(instructions,/预填.*docsImpact/);
          assert.match(instructions,/guide.*--brief/);
          assert.match(instructions,/最后运行run --all/);
          const spec=await read(path.join(root,specPath));
          assert.equal(spec.schemaVersion,1);
          assert.equal(spec.id,`${task.id}-iteration`);
          assert.deepEqual(spec.writeScopes,[task.entry,"test/extra.test.mjs"]);
          assert.deepEqual(spec.verification,[{command:"node",args:["--test","test/public.test.mjs"]}]);
          assert.deepEqual(spec.references,["TASK.md"]);
          assert.equal(spec.risk,"");assert.equal(spec.approach,"");
          assert.doesNotMatch(JSON.stringify(spec),/const cases=|BENCHMARK_/);
          await assert.rejects(()=>loadBeginSpec(root,specPath),/risk/);
          await writeFile(path.join(root,task.entry),task.reference);
          await writeFile(path.join(outputDirectory,"events.jsonl"),'{"type":"synthetic"}\n');
          return synthetic();
        }});
      assert.equal(row.grade.ok,true);
      assert.equal(row.scope.ok,true);
      assert.deepEqual(taskManifest(task),manifest);
      assert.match(participantPrompt(task,groups("fixture","reference")[1]),/begin --spec/);
      assert.match(participantPrompt(task,groups("fixture","reference")[1]),/不要编辑该JSON/);
      assert.match(participantPrompt(task,groups("fixture","reference")[1]),/guide.*--brief/);
      assert.match(participantPrompt(task,groups("fixture","reference")[1]),/finish.*check --ci.*最终/);
    }
  }finally{await cleanup(directory);}
});

test("CLI judgments complete core Harness with one begin, run, finish and check without editing spec",async()=>{
  const directory=await temporary(),task=tasks[0],group=groups("fixture","reference")[1];
  try{
    const result=await runCase({task,group,sourceRoot,outputDirectory:path.join(directory,"run"),driver:async({root,outputDirectory})=>{
      const file=path.join(root,specPath),definition=await read(file);
      assert.equal(definition.risk,"");assert.equal(definition.approach,"");
      const approach="按公开规格修复CSV解析并在最终计划检查前完成额外测试";
      const started=cli(root,["begin","--spec",specPath,"--risk","low","--approach",approach,"--json"]);
      assert.equal(started.status,"IMPLEMENTING");
      const plan=await loadPlan(root,definition.id);
      assert.equal(plan.rationale,approach);
      assert.deepEqual(plan.tasks[0].writeScopes,[task.entry,"test/extra.test.mjs"]);
      assert.deepEqual(plan.tasks[0].checks[0].args,["--test","test/public.test.mjs"]);
      const guide=cli(root,["guide","--id",definition.id,"--task","T1","--brief","--json"]);
      assert.equal(guide.next.code,"implement-and-verify");
      await writeFile(path.join(root,task.entry),task.reference);
      await writeFile(path.join(root,"test/extra.test.mjs"),'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\n');
      const verified=cli(root,["run","--id",definition.id,"--all","--json"]);
      assert.equal(verified.status,"pass");
      const completed=cli(root,["finish","--id",definition.id,"--verification","公共测试真实通过","--review","检查代码与公开契约","--documentation","N/A: 固定公开文档没有变化","--acceptance","公开测试和规格均已检查","--json"]);
      assert.equal(completed.status,"DONE");
      const checked=cli(root,["check","--ci","--json"]);
      assert.equal(checked.ok,true);
      assert.deepEqual(await read(file),definition);
      assert.equal((await loadWorkItem(root,definition.id)).status,"DONE");
      await writeFile(path.join(outputDirectory,"events.jsonl"),'{"type":"synthetic"}\n');
      return synthetic();
    }});
    assert.equal(result.success,true);
    assert.equal(result.grade.ok,true);
    assert.equal(result.workflow.ok,true);
  }finally{await cleanup(directory);}
});

test("editing the frozen core spec is a scope violation even when legacy workflow and function both pass",async()=>{
  const directory=await temporary(),task=tasks[0],group=groups("fixture","reference")[1];
  try{
    const result=await runCase({task,group,sourceRoot,outputDirectory:path.join(directory,"legacy-edit"),driver:async({root,outputDirectory})=>{
      const file=path.join(root,specPath),definition=await read(file);
      definition.risk="low";
      definition.approach="编辑预填spec走旧入口";
      await writeFile(file,JSON.stringify(definition,null,2)+"\n");
      const started=cli(root,["begin","--spec",specPath,"--json"]);
      await writeFile(path.join(root,task.entry),task.reference);
      const verified=cli(root,["run","--id",started.id,"--all","--json"]);
      assert.equal(verified.status,"pass");
      assert.equal(cli(root,["finish","--id",started.id,"--verification","公共测试通过","--review","检查固定契约","--documentation","N/A: 固定文档不变","--acceptance","公开验收通过","--json"]).status,"DONE");
      assert.equal(cli(root,["check","--ci","--json"]).ok,true);
      await writeFile(path.join(outputDirectory,"events.jsonl"),'{"type":"synthetic"}\n');
      return synthetic();
    }});
    assert.equal(result.grade.ok,true);
    assert.equal(result.workflow.ok,true);
    assert.equal(result.scope.ok,false);
    assert.ok(result.scope.violations.includes(`${specPath} changed`));
    assert.equal(result.success,false);
  }finally{await cleanup(directory);}
});

test("baseline and project participants retain their current prompts and have no prefilled spec",async()=>{
  const directory=await temporary();
  try{
    for(const [task,group,name]of [
      [tasks[0],groups("fixture","reference")[0],"baseline"],
      [projectTasks[0],groups("fixture","reference")[1],"project"],
    ]){
      await runCase({task,group,sourceRoot,outputDirectory:path.join(directory,name),driver:async({root,outputDirectory})=>{
        await assert.rejects(()=>readFile(path.join(root,specPath)),{code:"ENOENT"});
        assert.doesNotMatch(await readFile(path.join(root,"AGENTS.md"),"utf8"),/benchmark-begin-spec\.json/);
        assert.doesNotMatch(participantPrompt(task,group),/benchmark-begin-spec\.json/);
        if(task.writableFiles){for(const [file,content]of Object.entries(task.reference))await writeFile(path.join(root,file),content);}
        else await writeFile(path.join(root,task.entry),task.reference);
        await writeFile(path.join(outputDirectory,"events.jsonl"),'{"type":"synthetic"}\n');
        return synthetic();
      }});
    }
  }finally{await cleanup(directory);}
});
