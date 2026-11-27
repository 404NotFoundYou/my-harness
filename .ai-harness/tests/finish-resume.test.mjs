import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkProject } from "../src/checker.mjs";
import { beginWorkItem, finishWorkItem } from "../src/compact.mjs";
import { getWorkGuide } from "../src/guide.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { readEvidence } from "../src/verification.mjs";
import { loadWorkItem, recordResult, transitionWorkItem, updateTaskStatus } from "../src/workflow.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

const results = { verification: "actual syntax check protects the entrypoint", review: "reviewed the bounded diff", documentation: "N/A：接口未变", acceptance: "requested behavior checked", cleanup: ["none=isolated source fixture produced no obsolete build or test packages"] };
async function setup() {
  const root = await createInstalledProject();
  await writeFile(path.join(root, "value.mjs"), "export const value = 1;\n");
  await beginWorkItem(root, { id: "RESUME", type: "ITERATION", title: "resumable completion", references: ["request"], acceptance: ["valid module"], authorizationMode: "autonomous", authorizationSource: "user request", risk: "low", approach: "preserve module", databaseEvidence: "no persistence", writeScopes: ["value.mjs"], verification: ["node --check value.mjs"], docsImpact: ["N/A: unchanged"] });
  await runRecordedCommand(root, { id: "RESUME", taskId: "T1", checkId: "V1" });
  return root;
}
const steps = [
  root => recordResult(root, "RESUME", { taskId: "T1", kind: "verification", status: "pass", summary: results.verification }),
  root => updateTaskStatus(root, "RESUME", "T1", "IMPLEMENTED"),
  root => updateTaskStatus(root, "RESUME", "T1", "IN_REVIEW"),
  root => recordResult(root, "RESUME", { taskId: "T1", kind: "review", status: "pass", summary: results.review }),
  root => updateTaskStatus(root, "RESUME", "T1", "COMPLETED"),
  root => transitionWorkItem(root, "RESUME", "VERIFYING"),
  root => recordResult(root, "RESUME", { kind: "verification", status: "pass", summary: results.verification }),
  root => recordResult(root, "RESUME", { kind: "documentation", status: "not-applicable", summary: results.documentation }),
  root => transitionWorkItem(root, "RESUME", "CODE_REVIEW"),
  root => recordResult(root, "RESUME", { kind: "review", status: "pass", summary: results.review }),
  root => transitionWorkItem(root, "RESUME", "READY_FOR_ACCEPTANCE"),
  root => recordResult(root, "RESUME", { kind: "acceptance", status: "pass", summary: results.acceptance, cleanup: results.cleanup }),
];

for (const boundary of [2, 4, 7, 9, 12]) test(`finish resumes after step ${boundary} without rerunning checks or rewriting completed evidence`, async () => {
  const root = await setup();
  try {
    for (const step of steps.slice(0, boundary)) await step(root);
    const before = await readEvidence(root, "RESUME");
    const guide = await getWorkGuide(root, "RESUME");
    assert.equal(guide.next.code, "finish-iteration");
    const needed = Object.fromEntries(Object.entries(results).filter(([key]) => guide.next.command.args.includes(`--${key}`)));
    await finishWorkItem(root, "RESUME", needed);
    const after = await readEvidence(root, "RESUME");
    assert.equal(after.filter(event => event.kind === "command").length, 1);
    for (const event of before) assert.equal(after.filter(other => other.id === event.id).length, 1);
    const files = ["state.json", "plan.json", "events.jsonl", "evidence.jsonl"];
    const snapshot = await Promise.all(files.map(file => readFile(path.join(root, ".ai-harness/work-items/RESUME", file), "utf8")));
    assert.equal((await finishWorkItem(root, "RESUME")).alreadyDone, true);
    assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(root, ".ai-harness/work-items/RESUME", file), "utf8"))), snapshot);
  } finally { await cleanup(root); }
});

test("resuming cannot replace a failed review or reuse earlier code judgments", async () => {
  const root = await setup();
  try {
    for (const step of steps.slice(0, 9)) await step(root);
    await recordResult(root, "RESUME", { kind: "review", status: "fail", summary: "actual finding needs rework" });
    await recordResult(root, "RESUME", { kind: "review", status: "pending", summary: "investigating" });
    await assert.rejects(() => finishWorkItem(root, "RESUME", results), { code: "REVIEW_REWORK_REQUIRED" });
    assert.equal((await loadWorkItem(root, "RESUME")).status, "CODE_REVIEW");
  } finally { await cleanup(root); }
  const other = await setup();
  try {
    for (const step of steps.slice(0, 6)) await step(other);
    await writeFile(path.join(other, "value.mjs"), "export const value = 2;\n");
    await runRecordedCommand(other, { id: "RESUME", taskId: "T1", checkId: "V1" });
    await assert.rejects(() => finishWorkItem(other, "RESUME", results), { code: "STALE_COMPLETION" });
    assert.equal((await loadWorkItem(other, "RESUME")).status, "VERIFYING");
  } finally { await cleanup(other); }
});

test("cleanup is a precondition for both acceptance routes, including ignored packages", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, ".git/info/exclude"), "obsolete-test.zip\n");
    await writeFile(path.join(root, "obsolete-test.zip"), "old package");
    const { cleanup: ignored, ...judgments } = results;
    await assert.rejects(() => finishWorkItem(root, "RESUME", judgments), { code: "CLEANUP_REQUIRED" });
    assert.equal((await loadWorkItem(root, "RESUME")).status, "IMPLEMENTING");
    for (const step of steps.slice(0, -1)) await step(root);
    const acceptance = { kind: "acceptance", status: "pass", summary: results.acceptance };
    for (const cleanup of [[], ["cleaned=obsolete-test.zip"], ["none= "], ["retained=for rollback", "none=no candidates"]]) {
      await assert.rejects(() => recordResult(root, "RESUME", { ...acceptance, cleanup }), { code: "CLEANUP_REQUIRED" });
    }
    await rm(path.join(root, "obsolete-test.zip"));
    const cleanup = ["cleaned=owned ignored test package had no consumers", "released=obsolete-test.zip absent after unlink", "retained=tracked rollback fixture remains in use"];
    await recordResult(root, "RESUME", { ...acceptance, cleanup });
    assert.equal((await finishWorkItem(root, "RESUME")).status, "DONE");
    assert.deepEqual((await readEvidence(root, "RESUME")).findLast(e => e.kind === "acceptance").cleanup, cleanup);
  } finally { await cleanup(root); }
});

// Reproduce the on-disk acceptance format of a pre-cleanup runtime in this disposable fixture.
async function removeCleanupFromFixture(root) {
  const directory = path.join(root, ".ai-harness/work-items/RESUME");
  const statePath = path.join(directory, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.acceptance.cleanup;
  if (state.delivery) delete state.delivery.cleanupVersion;
  await writeFile(statePath, JSON.stringify(state) + "\n");
  for (const name of ["evidence.jsonl", "events.jsonl"]) {
    const file = path.join(directory, name);
    const rows = (await readFile(file, "utf8")).trimEnd().split("\n").map(JSON.parse);
    for (const row of rows) { delete row.cleanup; delete row.cleanupVersion; }
    await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  }
}

test("upgrading after legacy acceptance asks only for cleanup and preserves the previous judgment", async () => {
  const root = await setup();
  try {
    for (const step of steps) await step(root);
    await removeCleanupFromFixture(root);
    const guide = await getWorkGuide(root, "RESUME");
    assert.ok(guide.next.command.args.includes("--cleanup"));
    assert.ok(!guide.next.command.args.includes("--acceptance"));
    await assert.rejects(() => transitionWorkItem(root, "RESUME", "DONE"), { code: "CLEANUP_REQUIRED" });
    const records = await readEvidence(root, "RESUME");
    await finishWorkItem(root, "RESUME", { cleanup: ["retained=rollback fixture still needed"] });
    const after = await readEvidence(root, "RESUME");
    assert.deepEqual(after.slice(0, -1), records);
    assert.equal(after.at(-1).summary, results.acceptance);
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
  } finally { await cleanup(root); }
});

test("CI authenticates the new cleanup evidence without invalidating a frozen legacy delivery", async () => {
  const root = await setup();
  try {
    await finishWorkItem(root, "RESUME", results);
    const statePath = path.join(root, ".ai-harness/work-items/RESUME/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.acceptance.cleanup = ["retained=different conclusion"];
    await writeFile(statePath, JSON.stringify(state));
    assert.ok((await checkProject(root, { ci: true })).errors.some(e => e.includes("清理")));
    await assert.rejects(() => finishWorkItem(root, "RESUME"), { code: "CHECK_FAILED" });
    await removeCleanupFromFixture(root);
    const before = await readFile(statePath);
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
    assert.equal((await finishWorkItem(root, "RESUME")).alreadyDone, true);
    assert.deepEqual(await readFile(statePath), before);
  } finally { await cleanup(root); }
});
