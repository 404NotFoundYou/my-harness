import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";
import { hash, summarize } from "./runner.mjs";
import { experimentPlan } from "./experiment.mjs";
import { completedRun } from "./protocol.mjs";
import { readProtocolTranscript } from "./client-drivers.mjs";

export async function auditExperiment(directory) {
  const read = async file => JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const protocol = await read("protocol.json");
  const summary = await read("summary.json");
  assert.ok([1, 2].includes(protocol.schemaVersion));
  const extended = protocol.schemaVersion === 2;
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
    repetitions: protocol.repetitions, timeoutMs: protocol.budget.timeoutMs, maxToolCalls: protocol.budget.maxToolCalls }).schedule : null;
  if (extended) { assert.deepEqual(protocol.schedule, schedule); assert.deepEqual(summary.notRun, []); }
  const rows = [];
  for (const task of tasks) {
    const definition = protocol.tasks.find(entry=>entry.id===task.id);
    assert.equal(definition?.taskDigest, hash(JSON.stringify(task.files)));
    assert.equal(definition?.judgeDigest, hash(JSON.stringify(task.cases)));
    for (const group of protocol.groups) for (let trial = 1; trial <= (extended ? protocol.repetitions : 1); trial++) {
      const folder = `${task.id}-${group.id}${extended && protocol.repetitions > 1 ? `-trial-${trial}` : ""}`;
      const row = await read(`${folder}/result.json`);
      assert.equal(row.mode, protocol.mode);
      if (extended) {
        assert.equal(row.trial, trial);
        if (protocol.mode === "real") assert.equal(row.run.completed, completedRun(row.run, row.run.final));
      }
      assert.equal(row.client || "codex", protocol.client || "codex");
      assert.equal(row.taskId, task.id);
      assert.equal(row.group, group.id);
      assert.equal(row.model, group.model);
      assert.equal(row.taskDigest, definition.taskDigest);
      assert.equal(row.judgeDigest, definition.judgeDigest);
      assert.equal(row.candidateDigest, hash(await readFile(path.join(directory, folder, "candidate.mjs"))));
      assert.deepEqual(row.budget, protocol.budget);
      if (row.grade.complete) assert.deepEqual(row.grade.cases.map(entry=>entry.id), task.cases.map(([id])=>id));
      assert.equal(row.grade.ok, row.grade.complete && row.grade.exitCode===0 && row.grade.cases.every(entry=>entry.pass));
      assert.equal(row.success, Boolean(row.run.completed && row.scope.ok && row.grade.ok && (!group.harness || row.workflow?.ok)));
      assert.equal(row.falseCompletion, Boolean(row.run.final?.completed && !row.success));
      const transcript = await readFile(path.join(directory, folder, "events.jsonl"), "utf8");
      if (extended && protocol.mode === "real") {
        const finalText = protocol.client === "codex" ? await readFile(path.join(directory, folder, "final.json"), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; }) : null;
        const observed = readProtocolTranscript(protocol.client, transcript, finalText);
        for (const key of ["turnCompleted", "protocolSuccess", "unparsedLines", "errors", "warnings", "final", "usage"]) assert.deepEqual(row.run[key], observed[key], `${folder}: ${key} differs from raw protocol`);
        assert.equal(row.run.completed, completedRun({ ...row.run, ...observed }, observed.final));
      }
      rows.push(row);
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
  return { valid: true, mode: protocol.mode, samples: rows.length, source: protocol.source, groups: expected, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditExperiment(path.resolve(process.argv[2] || ""));
  console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
}
