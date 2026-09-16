import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { taskManifest, tasksForSuite } from "./task-contract.mjs";
import { hash, summarize } from "./runner.mjs";
import { experimentPlan } from "./experiment.mjs";
import { auditTrial } from "./audit-trial.mjs";
import { executionSummary, readExecution } from "./execution.mjs";

export async function auditExperiment(directory) {
  const read = async file => JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const protocol = await read("protocol.json");
  const summary = await read("summary.json");
  assert.ok([1, 2, 3, 4].includes(protocol.schemaVersion));
  const extended = protocol.schemaVersion >= 2;
  const resumable=protocol.schemaVersion === 4;
  const project = protocol.schemaVersion === 3||(resumable&&protocol.suite === "project");
  if (project) assert.equal(protocol.suite,"project");
  else assert.equal(protocol.suite,resumable?"core":undefined);
  const tasks=tasksForSuite(project?protocol.suite:"core");
  assert.ok(extended ? ["real", "simulated"].includes(protocol.mode) : protocol.mode === "real");
  assert.equal(summary.mode, protocol.mode);
  assert.equal(summary.complete, true, "experiment is incomplete");
  assert.equal(summary.sourceBefore, protocol.source);
  assert.equal(summary.sourceAfter, protocol.source);
  const groupIds = extended && protocol.comparison === "paired" ? ["weak-baseline", "weak-harness"] : ["strong-reference", "weak-baseline", "weak-harness"];
  assert.deepEqual(protocol.groups.map(group=>group.id).sort(), groupIds);
  assert.equal(protocol.groups.find(group=>group.id==="weak-baseline").model, protocol.groups.find(group=>group.id==="weak-harness").model);
  for (const group of protocol.groups) assert.equal(group.harness, group.id==="weak-harness");
  assert.equal(protocol.tasks.length, tasks.length);
  const schedule = extended ? experimentPlan({ weak: protocol.groups.find(group => group.id === "weak-baseline").model,
    strong: protocol.groups.find(group => group.id === "strong-reference")?.model, client: protocol.client, comparison: protocol.comparison,
    repetitions: protocol.repetitions, timeoutMs: protocol.budget.timeoutMs, maxToolCalls: protocol.budget.maxToolCalls, suite: project?protocol.suite:undefined }).schedule : null;
  if (project||resumable) assert.deepEqual(protocol.tasks,tasks.map(taskManifest));
  if (extended) { assert.deepEqual(protocol.schedule, schedule); assert.deepEqual(summary.notRun, []); }
  const rows = [];
  for (const task of tasks) {
    const definition = protocol.tasks.find(entry=>entry.id===task.id);
    assert.equal(definition?.taskDigest, hash(JSON.stringify(task.files)));
    assert.equal(definition?.judgeDigest, hash(JSON.stringify(task.cases)));
    for (const group of protocol.groups) for (let trial = 1; trial <= (extended ? protocol.repetitions : 1); trial++) {
      rows.push(await auditTrial(directory,protocol,task,group,trial));
    }
  }
  assert.equal(summary.results.length, rows.length);
  if (extended) {
    const key = row => `${row.taskId}:${row.group}:${row.trial}`;
    assert.deepEqual(summary.results.map(row => [row.taskId, row.group, row.trial]).sort(), schedule.map(row => [row.taskId, row.group, row.trial]).sort());
    assert.deepEqual([...summary.results].sort((a, b) => key(a).localeCompare(key(b))), rows.map(row => ({ taskId: row.taskId, group: row.group, trial: row.trial, success: row.success, functionalPassed: row.grade.ok })).sort((a, b) => key(a).localeCompare(key(b))));
  }
  const expected = summarize(rows, { extended }).sort((a,b)=>a.group.localeCompare(b.group));
  assert.deepEqual([...summary.groups].sort((a,b)=>a.group.localeCompare(b.group)), expected);
  if(resumable){
    const recovered=await readExecution(directory,protocol);
    assert.equal(recovered.changed,false,"Execution ledger needs resume reconciliation");
    assert.deepEqual(summary,executionSummary(protocol,recovered.ledger,recovered.rows,protocol.source),"Summary differs from execution ledger");
  }
  return { valid: true, mode: protocol.mode, samples: rows.length, source: protocol.source, groups: expected, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditExperiment(path.resolve(process.argv[2] || ""));
  console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
}
