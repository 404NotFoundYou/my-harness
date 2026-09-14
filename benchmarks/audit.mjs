import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tasks } from "./tasks.mjs";
import { hash, summarize } from "./runner.mjs";

export async function auditExperiment(directory) {
  const read = async file => JSON.parse(await readFile(path.join(directory, file), "utf8"));
  const protocol = await read("protocol.json");
  const summary = await read("summary.json");
  assert.equal(protocol.mode, "real");
  assert.equal(summary.mode, "real");
  assert.equal(summary.complete, true, "experiment is incomplete");
  assert.equal(summary.sourceBefore, protocol.source);
  assert.equal(summary.sourceAfter, protocol.source);
  assert.equal(protocol.groups.length, 3);
  assert.equal(new Set(protocol.groups.map(group=>group.id)).size, 3);
  assert.deepEqual(protocol.groups.map(group=>group.id).sort(), ["strong-reference", "weak-baseline", "weak-harness"]);
  assert.equal(protocol.groups.find(group=>group.id==="weak-baseline").model, protocol.groups.find(group=>group.id==="weak-harness").model);
  for (const group of protocol.groups) assert.equal(group.harness, group.id==="weak-harness");
  assert.equal(protocol.tasks.length, tasks.length);
  const rows = [];
  for (const task of tasks) {
    const definition = protocol.tasks.find(entry=>entry.id===task.id);
    assert.equal(definition?.taskDigest, hash(JSON.stringify(task.files)));
    assert.equal(definition?.judgeDigest, hash(JSON.stringify(task.cases)));
    for (const group of protocol.groups) {
      const folder = `${task.id}-${group.id}`;
      const row = await read(`${folder}/result.json`);
      assert.equal(row.mode, "real");
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
      await readFile(path.join(directory, folder, "events.jsonl"), "utf8");
      rows.push(row);
    }
  }
  assert.equal(summary.results.length, rows.length);
  const expected = summarize(rows).sort((a,b)=>a.group.localeCompare(b.group));
  assert.deepEqual([...summary.groups].sort((a,b)=>a.group.localeCompare(b.group)), expected);
  return { valid: true, samples: rows.length, source: protocol.source, groups: expected, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await auditExperiment(path.resolve(process.argv[2] || ""));
  console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));
}
