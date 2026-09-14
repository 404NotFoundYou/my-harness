import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanup, createInstalledProject } from "./helpers.mjs";
import { checkProject } from "../src/checker.mjs";
import { parseArgs } from "../src/cli.mjs";
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
  workItemPaths,
} from "../src/workflow.mjs";

// 把一个开发型工作项一路推进到 VERIFYING，任务已 COMPLETED。flags 决定流水线是否生效。
async function advanceToVerifying(root, id, flags) {
  await createWorkItemState(root, {
    id,
    type: "ITERATION",
    title: "codegen pipeline test",
    references: ["approved requirement"],
    acceptance: ["pipeline gates pass"],
    nonGoals: ["deployment"],
    authorizationMode: "autonomous",
    authorizationSource: "test authorization",
    flags,
  });
  await transitionWorkItem(root, id, "BASELINING");
  await completeBaseline(root, id, { evidence: ["temporary git baseline"] });
  await transitionWorkItem(root, id, "SOLUTION_DESIGN");
  await writeFile(path.join(root, "solution.md"), "# Solution\n\nNo database changes.\n", "utf8");
  await completeSolution(root, id, { document: "solution.md", evidence: ["approved flow and API sketch"] });
  await setDatabaseDecision(root, id, { impact: "none", evidence: ["no persistence path changes"] });
  await initializePlan(root, id, { mode: "single", rationale: "one bounded task" });
  await addReviewBatch(root, id, { id: "R1", title: "pipeline", risk: "medium", independentRequired: false });
  await addTask(root, id, {
    id: "T1",
    title: "generate code",
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

async function recordStage(root, id, stage, status = "pass") {
  return recordResult(root, id, { kind: "verification", status, summary: `${stage} stage evidence`, stage });
}

test("codegen+frontend 工作项只有五段流水线全部按序通过才能进入 CODE_REVIEW 并完成", async () => {
  const root = await createInstalledProject();
  try {
    await advanceToVerifying(root, "CG-1", ["codegen", "frontend"]);
    for (const stage of ["static", "sandbox", "contract", "eval", "browser"]) {
      await recordStage(root, "CG-1", stage);
    }
    const item = await loadWorkItem(root, "CG-1");
    assert.equal(item.verification.status, "pass");
    assert.equal(item.verification.stages.length, 5);
    await recordResult(root, "CG-1", { kind: "documentation", status: "pass", summary: "docs current" });
    await transitionWorkItem(root, "CG-1", "CODE_REVIEW");
    await recordResult(root, "CG-1", { kind: "review", status: "pass", summary: "final diff reviewed" });
    await transitionWorkItem(root, "CG-1", "READY_FOR_ACCEPTANCE");
    await recordResult(root, "CG-1", { kind: "acceptance", status: "pass", summary: "authorized acceptance" });
    const done = await transitionWorkItem(root, "CG-1", "DONE");
    assert.equal(done.status, "DONE");
    const check = await checkProject(root, { ci: true });
    assert.deepEqual(check.errors, []);
  } finally {
    await cleanup(root);
  }
});

test("codegen 但无 frontend 时 browser 子阶段可选，前四段通过即可聚合为 pass", async () => {
  const root = await createInstalledProject();
  try {
    await advanceToVerifying(root, "CG-2", ["codegen"]);
    for (const stage of ["static", "sandbox", "contract", "eval"]) {
      await recordStage(root, "CG-2", stage);
    }
    const item = await loadWorkItem(root, "CG-2");
    assert.equal(item.verification.status, "pass");
    await recordResult(root, "CG-2", { kind: "documentation", status: "pass", summary: "docs current" });
    const reviewing = await transitionWorkItem(root, "CG-2", "CODE_REVIEW");
    assert.equal(reviewing.status, "CODE_REVIEW");
  } finally {
    await cleanup(root);
  }
});

test("乱序记录子阶段被确定性拒绝", async () => {
  const root = await createInstalledProject();
  try {
    await advanceToVerifying(root, "CG-3", ["codegen"]);
    await assert.rejects(() => recordStage(root, "CG-3", "sandbox"), { code: "VERIFICATION_STAGE_ORDER" });
  } finally {
    await cleanup(root);
  }
});

test("codegen+frontend 缺 browser 段时无法进入 CODE_REVIEW", async () => {
  const root = await createInstalledProject();
  try {
    await advanceToVerifying(root, "CG-4", ["codegen", "frontend"]);
    for (const stage of ["static", "sandbox", "contract", "eval"]) {
      await recordStage(root, "CG-4", stage);
    }
    await recordResult(root, "CG-4", { kind: "documentation", status: "pass", summary: "docs current" });
    await assert.rejects(() => transitionWorkItem(root, "CG-4", "CODE_REVIEW"), { code: "VERIFICATION_PIPELINE_INCOMPLETE" });
  } finally {
    await cleanup(root);
  }
});

test("codegen 工作项禁止用裸 verification 记录绕过流水线", async () => {
  const root = await createInstalledProject();
  try {
    await advanceToVerifying(root, "CG-5", ["codegen"]);
    await assert.rejects(
      () => recordResult(root, "CG-5", { kind: "verification", status: "pass", summary: "bare bypass" }),
      { code: "VERIFICATION_STAGE_REQUIRED" },
    );
  } finally {
    await cleanup(root);
  }
});

test("check 拒绝子阶段状态与证据不一致的手改 state", async () => {
  const root = await createInstalledProject();
  try {
    await advanceToVerifying(root, "CG-6", ["codegen"]);
    await recordStage(root, "CG-6", "static");
    const paths = await workItemPaths(root, "CG-6");
    const state = JSON.parse(await readFile(paths.state, "utf8"));
    state.verification.stages[0].status = "fail"; // 证据仍是 pass，制造不一致
    await writeFile(paths.state, JSON.stringify(state, null, 2), "utf8");
    const check = await checkProject(root, { ci: false });
    assert.equal(check.ok, false);
    assert.ok(check.errors.some((message) => message.includes("子阶段 static")));
  } finally {
    await cleanup(root);
  }
});

test("codegen 标志确定性路由到 verification 策略", async () => {
  const root = await createInstalledProject();
  try {
    const item = await createWorkItemState(root, {
      id: "CG-7",
      type: "ITERATION",
      title: "routing",
      references: ["req"],
      acceptance: ["ok"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
      flags: ["codegen"],
    });
    assert.ok(item.policyFiles.includes(".ai-harness/policies/verification.md"));
  } finally {
    await cleanup(root);
  }
});

test("record 命令解析 --stage 参数", () => {
  const parsed = parseArgs(["record", "--id", "CG-1", "--kind", "verification", "--stage", "static", "--status", "pass", "--evidence", "ok"]);
  assert.equal(parsed.options.stage, "static");
  assert.equal(parsed.options.kind, "verification");
});
