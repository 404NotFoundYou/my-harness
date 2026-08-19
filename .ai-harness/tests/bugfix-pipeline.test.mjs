import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanup, createInstalledProject } from "./helpers.mjs";
import { checkProject } from "../src/checker.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import {
  addReviewBatch,
  addTask,
  approvePlan,
  completeBaseline,
  completeSolution,
  createWorkItemState,
  initializePlan,
  loadWorkItem,
  recordResult,
  setDatabaseDecision,
  transitionWorkItem,
  updateTaskStatus,
} from "../src/workflow.mjs";

// 把一个 BUGFIX 工作项一路推进到 VERIFYING，任务已 COMPLETED。
async function advanceBugfixToVerifying(root, id, flags = []) {
  await createWorkItemState(root, {
    id,
    type: "BUGFIX",
    title: "repair behavior",
    references: ["issue"],
    acceptance: ["reproduction passes"],
    nonGoals: [],
    authorizationMode: "autonomous",
    authorizationSource: "test authorization",
    flags,
    bug: { actual: "returns 500", expected: "returns 200", reproduction: "call GET /health" },
  });
  await transitionWorkItem(root, id, "BASELINING");
  await completeBaseline(root, id, { evidence: ["temporary git baseline"] });
  await transitionWorkItem(root, id, "SOLUTION_DESIGN");
  await writeFile(path.join(root, "solution.md"), "# Solution\n\nRoot cause and fix.\n", "utf8");
  await completeSolution(root, id, { document: "solution.md", evidence: ["root cause identified"] });
  await setDatabaseDecision(root, id, { impact: "none", evidence: ["no persistence path changes"] });
  await initializePlan(root, id, { mode: "single", rationale: "one bounded fix" });
  await addReviewBatch(root, id, { id: "R1", title: "fix", risk: "medium", independentRequired: false });
  await addTask(root, id, {
    id: "T1",
    title: "apply fix",
    module: "runtime",
    blockedBy: [],
    writeScopes: ["solution.md"],
    verification: ["node --version"],
    docsImpact: ["solution.md"],
    reviewBatch: "R1",
    risk: "medium",
    owner: "test",
  });
  await approvePlan(root, id, "test authorization");
  await transitionWorkItem(root, id, "PLANNED");
  await transitionWorkItem(root, id, "IMPLEMENTING");
  await updateTaskStatus(root, id, "T1", "IN_PROGRESS");
  await recordResult(root, id, { kind: "verification", status: "pass", summary: "task verified", taskId: "T1" });
  await updateTaskStatus(root, id, "T1", "IMPLEMENTED");
  await updateTaskStatus(root, id, "T1", "IN_REVIEW");
  await recordResult(root, id, { kind: "review", status: "pass", summary: "task diff reviewed", taskId: "T1" });
  await updateTaskStatus(root, id, "T1", "COMPLETED");
  await transitionWorkItem(root, id, "VERIFYING");
}

async function passingRun(root, id) {
  return runRecordedCommand(root, { id, command: process.execPath, args: ["--version"] });
}

test("BUGFIX 走 static→sandbox→reproduction→regression 真跑流水线并完成", async () => {
  const root = await createInstalledProject();
  try {
    await advanceBugfixToVerifying(root, "BUG-1");
    await recordResult(root, "BUG-1", { kind: "verification", status: "pass", summary: "static ok", stage: "static" });
    await recordResult(root, "BUG-1", { kind: "verification", status: "pass", summary: "sandbox ok", stage: "sandbox" });
    const repro = await passingRun(root, "BUG-1");
    assert.equal(repro.status, "pass");
    await recordResult(root, "BUG-1", { kind: "verification", status: "pass", summary: "repro green", stage: "reproduction", commandRef: repro.id });
    const regression = await passingRun(root, "BUG-1");
    await recordResult(root, "BUG-1", { kind: "verification", status: "pass", summary: "suite green", stage: "regression", commandRef: regression.id });
    const item = await loadWorkItem(root, "BUG-1");
    assert.equal(item.verification.status, "pass");
    assert.equal(item.verification.stages.find((s) => s.stage === "reproduction").command, repro.id);
    await recordResult(root, "BUG-1", { kind: "documentation", status: "pass", summary: "docs current" });
    await transitionWorkItem(root, "BUG-1", "CODE_REVIEW");
    await recordResult(root, "BUG-1", { kind: "review", status: "pass", summary: "final diff reviewed" });
    await transitionWorkItem(root, "BUG-1", "READY_FOR_ACCEPTANCE");
    await recordResult(root, "BUG-1", { kind: "acceptance", status: "pass", summary: "authorized acceptance" });
    const done = await transitionWorkItem(root, "BUG-1", "DONE");
    assert.equal(done.status, "DONE");
    const check = await checkProject(root, { ci: true });
    assert.deepEqual(check.errors, []);
  } finally {
    await cleanup(root);
  }
});

test("reproduction 缺 --command 被拒绝", async () => {
  const root = await createInstalledProject();
  try {
    await advanceBugfixToVerifying(root, "BUG-2");
    await recordResult(root, "BUG-2", { kind: "verification", status: "pass", summary: "static ok", stage: "static" });
    await recordResult(root, "BUG-2", { kind: "verification", status: "pass", summary: "sandbox ok", stage: "sandbox" });
    await assert.rejects(
      () => recordResult(root, "BUG-2", { kind: "verification", status: "pass", summary: "repro", stage: "reproduction" }),
      { code: "STAGE_RUN_REQUIRED" },
    );
  } finally {
    await cleanup(root);
  }
});

test("reproduction 引用失败命令而记为 pass 被拒绝", async () => {
  const root = await createInstalledProject();
  try {
    await advanceBugfixToVerifying(root, "BUG-3");
    await recordResult(root, "BUG-3", { kind: "verification", status: "pass", summary: "static ok", stage: "static" });
    await recordResult(root, "BUG-3", { kind: "verification", status: "pass", summary: "sandbox ok", stage: "sandbox" });
    await writeFile(path.join(root, "bad.mjs"), "const x = (\n", "utf8");
    const failing = await runRecordedCommand(root, { id: "BUG-3", command: process.execPath, args: ["--check", path.join(root, "bad.mjs")] });
    assert.equal(failing.status, "fail");
    await assert.rejects(
      () => recordResult(root, "BUG-3", { kind: "verification", status: "pass", summary: "repro", stage: "reproduction", commandRef: failing.id }),
      { code: "STAGE_RUN_EVIDENCE_NOT_PASSING" },
    );
  } finally {
    await cleanup(root);
  }
});

test("BUGFIX 裸 verification 记录被拒绝", async () => {
  const root = await createInstalledProject();
  try {
    await advanceBugfixToVerifying(root, "BUG-4");
    await assert.rejects(
      () => recordResult(root, "BUG-4", { kind: "verification", status: "pass", summary: "bare" }),
      { code: "VERIFICATION_STAGE_REQUIRED" },
    );
  } finally {
    await cleanup(root);
  }
});

test("BUGFIX 缺 regression 段无法进入 CODE_REVIEW", async () => {
  const root = await createInstalledProject();
  try {
    await advanceBugfixToVerifying(root, "BUG-5");
    await recordResult(root, "BUG-5", { kind: "verification", status: "pass", summary: "static ok", stage: "static" });
    await recordResult(root, "BUG-5", { kind: "verification", status: "pass", summary: "sandbox ok", stage: "sandbox" });
    const repro = await passingRun(root, "BUG-5");
    await recordResult(root, "BUG-5", { kind: "verification", status: "pass", summary: "repro green", stage: "reproduction", commandRef: repro.id });
    await recordResult(root, "BUG-5", { kind: "documentation", status: "pass", summary: "docs current" });
    await assert.rejects(() => transitionWorkItem(root, "BUG-5", "CODE_REVIEW"), { code: "VERIFICATION_PIPELINE_INCOMPLETE" });
  } finally {
    await cleanup(root);
  }
});

test("BUGFIX + frontend 时 browser 段亦必需", async () => {
  const root = await createInstalledProject();
  try {
    await advanceBugfixToVerifying(root, "BUG-6", ["frontend"]);
    await recordResult(root, "BUG-6", { kind: "verification", status: "pass", summary: "static ok", stage: "static" });
    await recordResult(root, "BUG-6", { kind: "verification", status: "pass", summary: "sandbox ok", stage: "sandbox" });
    const repro = await passingRun(root, "BUG-6");
    await recordResult(root, "BUG-6", { kind: "verification", status: "pass", summary: "repro green", stage: "reproduction", commandRef: repro.id });
    const regression = await passingRun(root, "BUG-6");
    await recordResult(root, "BUG-6", { kind: "verification", status: "pass", summary: "suite green", stage: "regression", commandRef: regression.id });
    await recordResult(root, "BUG-6", { kind: "documentation", status: "pass", summary: "docs current" });
    await assert.rejects(() => transitionWorkItem(root, "BUG-6", "CODE_REVIEW"), { code: "VERIFICATION_PIPELINE_INCOMPLETE" });
    await recordResult(root, "BUG-6", { kind: "verification", status: "pass", summary: "browser probe green", stage: "browser" });
    const reviewing = await transitionWorkItem(root, "BUG-6", "CODE_REVIEW");
    assert.equal(reviewing.status, "CODE_REVIEW");
  } finally {
    await cleanup(root);
  }
});

test("BUGFIX 类型确定性路由到 verification 策略", async () => {
  const root = await createInstalledProject();
  try {
    const item = await createWorkItemState(root, {
      id: "BUG-7",
      type: "BUGFIX",
      title: "routing",
      references: ["issue"],
      acceptance: ["ok"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
      bug: { actual: "a", expected: "b", reproduction: "c" },
    });
    assert.ok(item.policyFiles.includes(".ai-harness/policies/verification.md"));
    assert.ok(item.policyFiles.includes(".ai-harness/policies/bugfix.md"));
  } finally {
    await cleanup(root);
  }
});
