import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { projectTasks } from "../project-tasks.mjs";
import { projectTasksV2 } from "../project-tasks-v2.mjs";
import { createParticipant, cleanupSandbox, gradeCandidate, hash } from "../runner.mjs";
import { experimentPlan, runExperiment } from "../experiment.mjs";
import { auditExperiment } from "../audit.mjs";
import { auditTrial } from "../audit-trial.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const candidate = (task, reference) => ({ schemaVersion: 1, files: Object.fromEntries(task.writableFiles.map(file => {
  const content = reference[file];
  return [file, { status: "present", content, sha256: hash(Buffer.from(content)) }];
})) });
const synthetic = () => ({ mode: "simulated", client: "codex", completed: true, final: { completed: true, summary: "fixture only", tests: [] }, durationMs: 1, usage: null });

test("new project suite is opt-in while historical project and core budgets stay frozen", () => {
  assert.deepEqual(projectTasksV2.slice(0, projectTasks.length), projectTasks);
  assert.deepEqual(projectTasksV2.map(task => task.split), ["development", "development", "holdout"]);
  assert.equal(experimentPlan({ weak: "w", strong: "s" }).schedule.length, 9);
  assert.equal(experimentPlan({ weak: "w", comparison: "paired", suite: "project" }).schedule.length, 2);
  const plan = experimentPlan({ weak: "w", comparison: "paired", suite: "project-v2" });
  assert.equal(plan.schedule.length, 6);
  assert.deepEqual([...new Set(plan.schedule.map(entry => entry.taskId))], projectTasksV2.map(task => task.id));
});

test("each new project task needs both repairs and the fixed public test starts red", async () => {
  for (const task of projectTasksV2.slice(projectTasks.length)) {
    const participant = await createParticipant(task, { sourceRoot, harness: false });
    try {
      const before = spawnSync(process.execPath, ["--test", "test/public.test.mjs"], { cwd: participant.root, encoding: "utf8", shell: false, windowsHide: true, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
      assert.notEqual(before.status, 0, `${task.id} public bug must reproduce`);
      for (const [file, content] of Object.entries(task.reference)) await writeFile(path.join(participant.root, file), content);
      const after = spawnSync(process.execPath, ["--test", "test/public.test.mjs"], { cwd: participant.root, encoding: "utf8", shell: false, windowsHide: true, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
      assert.equal(after.status, 0, `${task.id}: ${after.stderr}\n${after.stdout}`);
      const full = await gradeCandidate(task, candidate(task, task.reference));
      assert.equal(full.ok, true, `${task.id}: ${JSON.stringify(full)}`);
      assert.equal(full.cases.length, 12);
      for (const file of task.writableFiles) {
        const partial = candidate(task, { ...task.reference, [file]: task.files[file] });
        assert.equal((await gradeCandidate(task, partial)).ok, false, `${task.id}: ${file} must be repaired`);
      }
    } finally { await cleanupSandbox(participant.root); }
  }
});

test("new judges reject a serialization loss and an input-mutating interval repair", async () => {
  const config = projectTasksV2[1];
  const original = config.reference["src/config.mjs"];
  const lossy = original.replace("Object.fromEntries(orderedLayers(layers).flatMap(layer => Object.entries(layer.values)))", "JSON.parse(JSON.stringify(Object.fromEntries(orderedLayers(layers).flatMap(layer => Object.entries(layer.values)))))");
  assert.notEqual(lossy, original);
  assert.equal((await gradeCandidate(config, candidate(config, { ...config.reference, "src/config.mjs": lossy }))).ok, false);
  const nullish = original.replace("Object.fromEntries(orderedLayers(layers).flatMap(layer => Object.entries(layer.values)))", "Object.fromEntries(orderedLayers(layers).flatMap(layer => Object.entries(layer.values).map(([key,value]) => [key,value === undefined ? null : value])))");
  assert.notEqual(nullish, original);
  assert.equal((await gradeCandidate(config, candidate(config, { ...config.reference, "src/config.mjs": nullish }))).ok, false);
  const cloned = original.replace("Object.fromEntries(orderedLayers(layers).flatMap(layer => Object.entries(layer.values)))", "structuredClone(Object.fromEntries(orderedLayers(layers).flatMap(layer => Object.entries(layer.values))))");
  assert.notEqual(cloned, original);
  assert.equal((await gradeCandidate(config, candidate(config, { ...config.reference, "src/config.mjs": cloned }))).ok, false);

  const window = projectTasksV2[2];
  const mutating = `export function mergeIntervals(intervals) {
    const ordered=[...intervals].sort((a,b)=>a.start-b.start||a.end-b.end),result=[];
    for(const row of ordered){const last=result.at(-1);if(last&&row.start<=last.end)last.end=Math.max(last.end,row.end);else result.push(row);}
    return result;
  }\n`;
  assert.equal((await gradeCandidate(window, candidate(window, { ...window.reference, "src/intervals.mjs": mutating }))).ok, false);
  const windowMutator = window.reference["src/window.mjs"].replace("  return mergeIntervals(", "  window.start = window.start;\n  return mergeIntervals(");
  assert.notEqual(windowMutator, window.reference["src/window.mjs"]);
  assert.equal((await gradeCandidate(window, candidate(window, { ...window.reference, "src/window.mjs": windowMutator }))).ok, false);
});

test("new suite dry-run and simulated audit include both splits without model calls", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-project-v2-"));
  try {
    const outputDirectory = path.join(directory, "experiment");
    const args = [path.join(sourceRoot, "benchmarks/run.mjs"), "--cli", "not-installed", "--weak", "fixture", "--comparison", "paired", "--suite", "project-v2", "--out", outputDirectory, "--dry-run"];
    const dry = spawnSync(process.execPath, args, { cwd: sourceRoot, encoding: "utf8", shell: false, windowsHide: true });
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).modelCalls, 6);
    assert.deepEqual(await readdir(directory), []);
    const plan = experimentPlan({ weak: "fixture", comparison: "paired", suite: "project-v2", timeoutMs: 30000 });
    const summary = await runExperiment({ plan, sourceRoot, outputDirectory, mode: "simulated", driver: async ({ outputDirectory: output }) => {
      await writeFile(path.join(output, "events.jsonl"), '{"type":"synthetic"}\n');
      return synthetic();
    } });
    assert.equal(summary.complete, true);
    assert.equal(summary.results.length, 6);
    const audited = await auditExperiment(outputDirectory);
    assert.equal(audited.mode, "simulated");
    assert.equal(audited.samples, 6);
    const file = path.join(outputDirectory, "protocol.json"), original = await readFile(file, "utf8");
    const protocol = JSON.parse(original);
    const holdout = projectTasksV2.at(-1), baseline = protocol.groups.find(group => group.id === "weak-baseline");
    const row = JSON.parse(await readFile(path.join(outputDirectory, `${holdout.id}-${baseline.id}`, "result.json"), "utf8"));
    await assert.rejects(() => auditTrial(outputDirectory, protocol, holdout, baseline, 1, JSON.stringify({ ...row, split: "development" })), /split/);
    const tampered = JSON.parse(original);
    tampered.suite = "project";
    await writeFile(file, JSON.stringify(tampered));
    await assert.rejects(() => auditExperiment(outputDirectory));
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
