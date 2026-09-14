import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { beginWorkItem, finishWorkItem } from "../src/compact.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { checkProject } from "../src/checker.mjs";
import { getWorkGuide } from "../src/guide.mjs";
import {
  addAnalysisConclusion, addTask, approvePlan, completeBaseline, createWorkItemState,
  editTask, loadPlan, loadWorkItem, recordResult, reopenWorkItem, transitionWorkItem, updateTaskStatus,
} from "../src/workflow.mjs";
import { cleanup, createInstalledProject, git } from "./helpers.mjs";

const options = (id, file = "sample.mjs") => ({
  id, type: "ITERATION", title: "verified local change", references: ["user request"], acceptance: ["declared check succeeds"],
  authorizationMode: "autonomous", authorizationSource: "bounded task request", risk: "medium",
  approach: "preserve the existing behavior", databaseEvidence: "no persistence", writeScopes: [file],
  verification: [`node --check ${file}`], docsImpact: ["N/A: unchanged contract"],
});
const verdict = (id) => ({ commandIds: [id], verification: "actual declared check passed", review: "actual diff reviewed", documentation: "N/A: unchanged contract", acceptance: "acceptance checked" });
const run = (root, id, file = "sample.mjs", taskId = "T1") => runRecordedCommand(root, { id, taskId, command: process.execPath, args: ["--check", file] });

async function verifying(root, id, command, { aggregate = true } = {}) {
  await recordResult(root, id, { taskId: "T1", kind: "verification", status: "pass", summary: `command ${command.id}` });
  await updateTaskStatus(root, id, "T1", "IMPLEMENTED");
  await updateTaskStatus(root, id, "T1", "IN_REVIEW");
  await recordResult(root, id, { taskId: "T1", kind: "review", status: "pass", summary: "diff checked" });
  await updateTaskStatus(root, id, "T1", "COMPLETED");
  await transitionWorkItem(root, id, "VERIFYING");
  if (aggregate) await recordResult(root, id, { kind: "verification", status: "pass", summary: `command ${command.id}` });
  await recordResult(root, id, { kind: "documentation", status: "not-applicable", summary: "unchanged contract" });
}

test("stale code and unrelated commands cannot support a completion claim", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options("STALE"));
    await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
    const version = await runRecordedCommand(root, { id: "STALE", taskId: "T1", command: process.execPath, args: ["--version"] });
    assert.equal(version.command.checkIds.length, 0);
    await assert.rejects(() => finishWorkItem(root, "STALE", verdict(version.id)), { code: "VERIFICATION_NOT_CURRENT" });
    const checked = await run(root, "STALE");
    await writeFile(path.join(root, "sample.mjs"), "const = ;\n");
    await assert.rejects(() => finishWorkItem(root, "STALE", verdict(checked.id)), { code: "VERIFICATION_NOT_CURRENT" });
    assert.equal((await loadWorkItem(root, "STALE")).status, "IMPLEMENTING");
  } finally { await cleanup(root); }
});

test("a same-named executable does not satisfy an explicit planned command path", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, { ...options("EXECUTABLE"), verification: ["tools/node --version"] });
    const unrelated = await runRecordedCommand(root, { id: "EXECUTABLE", taskId: "T1", command: "node", args: ["--version"] });
    assert.equal(unrelated.status, "pass");
    assert.deepEqual(unrelated.command.checkIds, []);
    await assert.rejects(() => finishWorkItem(root, "EXECUTABLE", verdict(unrelated.id)), { code: "VERIFICATION_NOT_CURRENT" });
  } finally { await cleanup(root); }
});

test("Windows current Node path variants remain executable without weakening path approval", { skip: process.platform !== "win32" }, async () => {
  const root = await createInstalledProject();
  try {
    const command = process.execPath.toUpperCase();
    await beginWorkItem(root, { ...options("NODE-PATH"), verification: [JSON.stringify({ command, args: ["--version"] })] });
    const checked = await runRecordedCommand(root, { id: "NODE-PATH", taskId: "T1", checkId: "V1" });
    assert.equal(checked.status, "pass");
    assert.equal(checked.command.launch.executable, process.execPath);
    assert.equal((await finishWorkItem(root, "NODE-PATH", verdict(checked.id))).status, "DONE");
  } finally { await cleanup(root); }
});

test("a later failure invalidates pass and a real repair can complete through a new revision", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options("FAILURE"));
    await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
    const first = await run(root, "FAILURE");
    await verifying(root, "FAILURE", first);
    await writeFile(path.join(root, "sample.mjs"), "const = ;\n");
    const failure = await run(root, "FAILURE", "sample.mjs", null);
    assert.equal(failure.status, "fail");
    assert.equal((await loadWorkItem(root, "FAILURE")).verification.status, "pending");
    assert.notEqual((await getWorkGuide(root, "FAILURE")).next.workTarget, "CODE_REVIEW");
    await assert.rejects(() => transitionWorkItem(root, "FAILURE", "CODE_REVIEW"));
    await reopenWorkItem(root, "FAILURE", { reason: "repair the failed check" });
    await updateTaskStatus(root, "FAILURE", "T1", "IN_PROGRESS");
    await writeFile(path.join(root, "sample.mjs"), "const valid = 2;\n");
    await assert.rejects(() => finishWorkItem(root, "FAILURE", verdict(first.id)), { code: "VERIFICATION_NOT_CURRENT" });
    const current = await runRecordedCommand(root, { id: "FAILURE", taskId: "T1", checkId: "V1" });
    assert.equal(current.revision, 2);
    assert.equal((await finishWorkItem(root, "FAILURE", verdict(current.id))).status, "DONE");
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
  } finally { await cleanup(root); }
});

test("deleted files outside a task scope are rejected even when the declared check passes", async () => {
  const root = await createInstalledProject();
  try {
    await writeFile(path.join(root, "unrelated.txt"), "preserve me\n");
    git(root, ["add", "unrelated.txt"]);
    git(root, ["commit", "-m", "fixture baseline"]);
    await beginWorkItem(root, options("DELETE"));
    await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
    await rm(path.join(root, "unrelated.txt"));
    const command = await run(root, "DELETE");
    assert.equal(command.status, "pass");
    await assert.rejects(() => finishWorkItem(root, "DELETE", verdict(command.id)), { code: "CHECK_FAILED" });
    const checked = await checkProject(root);
    assert.ok(checked.errors.some((error) => error.includes("unrelated.txt")));
    await verifying(root, "DELETE", command);
    await transitionWorkItem(root, "DELETE", "CODE_REVIEW");
    await recordResult(root, "DELETE", { kind: "review", status: "pass", summary: "fixture review" });
    await transitionWorkItem(root, "DELETE", "READY_FOR_ACCEPTANCE");
    await recordResult(root, "DELETE", { kind: "acceptance", status: "pass", summary: "fixture acceptance" });
    await assert.rejects(() => transitionWorkItem(root, "DELETE", "DONE"), { code: "CHECK_FAILED" });
    assert.equal((await loadWorkItem(root, "DELETE")).status, "READY_FOR_ACCEPTANCE");
  } finally { await cleanup(root); }
});

test("completed scopes do not authorize a later task's unrelated modifications", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options("OLD", "old.mjs"));
    await writeFile(path.join(root, "old.mjs"), "const old = 1;\n");
    const first = await run(root, "OLD", "old.mjs");
    await finishWorkItem(root, "OLD", verdict(first.id));
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "old delivery"]);
    await beginWorkItem(root, options("NEW", "new.mjs"));
    await writeFile(path.join(root, "new.mjs"), "const current = 1;\n");
    await writeFile(path.join(root, "old.mjs"), "const outsideCurrentScope = 2;\n");
    const current = await run(root, "NEW", "new.mjs");
    await assert.rejects(() => finishWorkItem(root, "NEW", verdict(current.id)), { code: "CHECK_FAILED" });
    const checked = await checkProject(root);
    assert.ok(checked.errors.some((error) => error.includes("old.mjs")));
  } finally { await cleanup(root); }
});

test("analysis records are valid control changes without authorizing product writes", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options("DEV"));
    await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
    const command = await run(root, "DEV");
    await finishWorkItem(root, "DEV", verdict(command.id));
    await createWorkItemState(root, { id: "ANALYSIS", type: "ANALYSIS", title: "read behavior", references: ["question"], acceptance: ["answer with evidence"], authorizationMode: "approval-required", authorizationSource: "read-only request" });
    await transitionWorkItem(root, "ANALYSIS", "BASELINING");
    await completeBaseline(root, "ANALYSIS", { evidence: ["fixture code read"] });
    await transitionWorkItem(root, "ANALYSIS", "ANALYZING");
    await addAnalysisConclusion(root, "ANALYSIS", { status: "PROVEN", text: "sample exists", evidence: ["sample.mjs"] });
    await recordResult(root, "ANALYSIS", { kind: "analysis", status: "pass", summary: "question answered" });
    await transitionWorkItem(root, "ANALYSIS", "ANSWERED");
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
    await writeFile(path.join(root, "outside.mjs"), "const unintended = 1;\n");
    assert.equal((await checkProject(root, { ci: true })).ok, false);
  } finally { await cleanup(root); }
});

test("final review rework archives the prior plan and replan allows an authorized amendment", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options("REPLAN"));
    await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
    const command = await run(root, "REPLAN");
    await verifying(root, "REPLAN", command);
    await transitionWorkItem(root, "REPLAN", "CODE_REVIEW");
    await recordResult(root, "REPLAN", { kind: "review", status: "fail", summary: "needs another case" });
    assert.equal((await getWorkGuide(root, "REPLAN")).next.code, "reopen-work");
    await reopenWorkItem(root, "REPLAN", { reason: "add the missing case", replan: true });
    assert.equal((await loadWorkItem(root, "REPLAN")).plan.approved, false);
    assert.equal(JSON.parse(await readFile(path.join(root, ".ai-harness/work-items/REPLAN/revisions/1-state.json"), "utf8")).review.status, "fail");
    await editTask(root, "REPLAN", "T1", { writeScopes: ["sample.mjs", "extra.mjs"] });
    await addTask(root, "REPLAN", { ...taskFromOptions(options("REPLAN")), id: "T2", title: "second case", blockedBy: ["T1"], writeScopes: ["other.mjs"] });
    await approvePlan(root, "REPLAN", "authorized amendment");
    await transitionWorkItem(root, "REPLAN", "PLANNED");
    await transitionWorkItem(root, "REPLAN", "IMPLEMENTING");
    assert.equal((await loadPlan(root, "REPLAN")).tasks.length, 2);
  } finally { await cleanup(root); }
});

function taskFromOptions(value) {
  return { title: value.title, module: "fixture", owner: "test", writeScopes: value.writeScopes, verification: value.verification, docsImpact: value.docsImpact, risk: "medium", reviewBatch: "R1" };
}

test("pipeline stages cannot combine evidence from different source versions", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, { ...options("PIPELINE"), type: "BUGFIX", bug: { actual: "old output", expected: "correct output", reproduction: "check the sample" } });
    await writeFile(path.join(root, "sample.mjs"), "const value = 1;\n");
    const first = await run(root, "PIPELINE");
    await verifying(root, "PIPELINE", first, { aggregate: false });
    for (const stage of ["static", "sandbox"]) await recordResult(root, "PIPELINE", { kind: "verification", stage, status: "pass", summary: `${stage} fixture at version A` });
    await writeFile(path.join(root, "sample.mjs"), "const value = 2;\n");
    await assert.rejects(() => recordResult(root, "PIPELINE", { kind: "verification", stage: "reproduction", status: "pass", summary: "cannot reuse old stages by recording directly", commandRef: first.id }), { code: "VERIFICATION_STAGE_ORDER" });
    const current = await run(root, "PIPELINE", "sample.mjs", null);
    assert.equal((await loadWorkItem(root, "PIPELINE")).verification.stages.length, 0);
    await assert.rejects(() => recordResult(root, "PIPELINE", { kind: "verification", stage: "reproduction", status: "pass", summary: "new code", commandRef: current.id }), { code: "VERIFICATION_STAGE_ORDER" });
    for (const stage of ["static", "sandbox", "reproduction", "regression"]) await recordResult(root, "PIPELINE", { kind: "verification", stage, status: "pass", summary: `${stage} fixture at version B`, commandRef: ["reproduction", "regression"].includes(stage) ? current.id : null });
    await transitionWorkItem(root, "PIPELINE", "CODE_REVIEW");
  } finally { await cleanup(root); }
});

test("failed reviews require a new task attempt or work revision, even after a pending record", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options("REVIEW-FAIL"));
    await writeFile(path.join(root, "sample.mjs"), "const value = 1;\n");
    await run(root, "REVIEW-FAIL");
    await recordResult(root, "REVIEW-FAIL", { taskId: "T1", kind: "verification", status: "pass", summary: "checked" });
    await updateTaskStatus(root, "REVIEW-FAIL", "T1", "IMPLEMENTED");
    await updateTaskStatus(root, "REVIEW-FAIL", "T1", "IN_REVIEW");
    await recordResult(root, "REVIEW-FAIL", { taskId: "T1", kind: "review", status: "fail", summary: "fix required" });
    await recordResult(root, "REVIEW-FAIL", { taskId: "T1", kind: "review", status: "pending", summary: "still investigating" });
    await assert.rejects(() => recordResult(root, "REVIEW-FAIL", { taskId: "T1", kind: "review", status: "pass", summary: "not a recovery" }), { code: "REVIEW_REWORK_REQUIRED" });
    assert.equal((await getWorkGuide(root, "REVIEW-FAIL")).next.taskTarget, "REWORK");
    await updateTaskStatus(root, "REVIEW-FAIL", "T1", "REWORK");
    await updateTaskStatus(root, "REVIEW-FAIL", "T1", "IN_PROGRESS");
    const checked = await run(root, "REVIEW-FAIL");
    await verifying(root, "REVIEW-FAIL", checked);
    await transitionWorkItem(root, "REVIEW-FAIL", "CODE_REVIEW");
    await recordResult(root, "REVIEW-FAIL", { kind: "review", status: "fail", summary: "final review requires changes" });
    await recordResult(root, "REVIEW-FAIL", { kind: "review", status: "pending", summary: "still investigating" });
    await assert.rejects(() => recordResult(root, "REVIEW-FAIL", { kind: "review", status: "pass", summary: "not a recovery" }), { code: "REVIEW_REWORK_REQUIRED" });
    assert.equal((await getWorkGuide(root, "REVIEW-FAIL")).next.code, "reopen-work");
  } finally { await cleanup(root); }
});

test("parallel work items freeze only their own changes and both can finish", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options("A", "a.mjs"));
    await beginWorkItem(root, options("B", "b.mjs"));
    await writeFile(path.join(root, "a.mjs"), "const a = 1;\n");
    await writeFile(path.join(root, "b.mjs"), "const b = 2;\n");
    const a = await run(root, "A", "a.mjs");
    const b = await run(root, "B", "b.mjs");
    await finishWorkItem(root, "A", verdict(a.id));
    assert.deepEqual((await checkProject(root)).errors, []);
    await finishWorkItem(root, "B", verdict(b.id));
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
    assert.deepEqual((await loadWorkItem(root, "A")).delivery.ownedChanges.map((change) => change.path), ["a.mjs"]);
    assert.deepEqual((await loadWorkItem(root, "B")).delivery.ownedChanges.map((change) => change.path), ["b.mjs"]);
    await reopenWorkItem(root, "A", { reason: "extend delivery without reclaiming prior files", replan: true });
    await editTask(root, "A", "T1", { writeScopes: ["c.mjs"], verification: ["node --check c.mjs"] });
    await approvePlan(root, "A", "authorized follow-up");
    await transitionWorkItem(root, "A", "PLANNED");
    await transitionWorkItem(root, "A", "IMPLEMENTING");
    await updateTaskStatus(root, "A", "T1", "IN_PROGRESS");
    await writeFile(path.join(root, "c.mjs"), "const c = 3;\n");
    const c = await run(root, "A", "c.mjs");
    await finishWorkItem(root, "A", verdict(c.id));
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
    assert.deepEqual((await loadWorkItem(root, "A")).delivery.ownedChanges.map((change) => change.path), ["c.mjs"]);
  } finally { await cleanup(root); }
});

test("Windows npm runs an actual package test through the recorded executor", { skip: process.platform !== "win32" }, async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, { ...options("NPM"), writeScopes: ["package.json", "app.test.mjs"], verification: ["npm test"] });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ private: true, scripts: { test: "node --test app.test.mjs" } }));
    await writeFile(path.join(root, "app.test.mjs"), 'import assert from "node:assert/strict"; assert.equal(2 + 2, 4);\n');
    const command = await runRecordedCommand(root, { id: "NPM", taskId: "T1", checkId: "V1" });
    assert.equal(command.status, "pass", command.command.stderr.text);
    assert.equal(command.command.launch.executable, process.execPath);
    assert.equal((await finishWorkItem(root, "NPM", verdict(command.id))).status, "DONE");
  } finally { await cleanup(root); }
});
