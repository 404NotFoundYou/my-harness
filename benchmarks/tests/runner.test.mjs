import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { tasks } from "../tasks.mjs";
import { budget, cleanupSandbox, createParticipant, gradeCandidate, groups, inspectChanges, parseGrade, participantPrompt, runCase, summarize } from "../runner.mjs";
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");

test("hidden judges accept all reference contracts and reject incomplete implementations",async()=>{
  for(const task of tasks){
    const reference=await gradeCandidate(task,task.reference);
    assert.equal(reference.ok,true,JSON.stringify(reference));
    assert.equal(reference.cases.length,task.cases.length);
    assert.equal((await gradeCandidate(task,task.files[task.entry])).ok,false);
  }
});

test("exit zero, missing or duplicate tests cannot impersonate a completed acceptance run",async()=>{
  assert.equal((await gradeCandidate(tasks[0],`process.exit(0);export function parseCsv(){return [];}`)).ok,false);
  assert.equal(parseGrade('MARK{"cases":[{"id":"one","pass":true}]}',"MARK",["one","two"],0).ok,false);
  assert.equal(parseGrade('MARK{"cases":[{"id":"one","pass":true},{"id":"one","pass":true}]}',"MARK",["one","two"],0).ok,false);
});

test("all groups share contracts and budgets, while hidden cases and references stay outside participant files",async()=>{
  assert.equal(budget.timeoutMs,180000);
  const matrix=groups("weak","strong");
  assert.equal(matrix[0].model,matrix[1].model);
  for(const group of matrix){
    const participant=await createParticipant(tasks[0],{sourceRoot,harness:group.harness});
    try{
      for(const [file,content]of Object.entries(tasks[0].files))assert.equal(await readFile(path.join(participant.root,file),"utf8"),content);
      assert.equal((await readdir(participant.root)).includes("benchmarks"),false);
      assert.match(participantPrompt(tasks[0],group),/180秒、80次/);
      assert.equal((await inspectChanges(participant,tasks[0],group.harness)).ok,true);
      await writeFile(path.join(participant.root,"TASK.md"),"weakened task");
      assert.deepEqual((await inspectChanges(participant,tasks[0],group.harness)).violations,["TASK.md"]);
    }finally{await cleanupSandbox(participant.root);}
  }
});

test("a simulated driver exercises grading and false completion without becoming a real model result",async()=>{
  const output=await mkdtemp(path.join(tmpdir(),"ai-harness-bench-test-"));
  try{
    const row=await runCase({task:tasks[0],group:groups("weak","strong")[0],sourceRoot,outputDirectory:output,
      driver:async()=>({mode:"simulated",completed:true,final:{completed:true},durationMs:1,usage:null})});
    assert.equal(row.falseFunctionalCompletion,true);
    assert.equal(row.success,false);
    assert.equal(summarize([row])[0].completed,0);
    assert.throws(()=>summarize([row,{...row,mode:"real"}]));
  }finally{
    const resolved=path.resolve(output);
    assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ai-harness-bench-test-"));
    await rm(resolved,{recursive:true,force:true});
  }
});
