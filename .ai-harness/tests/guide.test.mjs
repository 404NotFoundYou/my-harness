import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getWorkGuide } from "../src/guide.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { exists } from "../src/filesystem.mjs";
import {
  addAnalysisConclusion, addReviewBatch, addTask, approvePlan, completeBaseline,
  completeSolution, createWorkItemState, initializePlan, loadWorkItem, recordResult,
  setDatabaseDecision, transitionWorkItem, updateTaskStatus, workItemPaths,
} from "../src/workflow.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

const id = "GUIDE-1";
const taskOptions = {
  id: "T1", title: "protect local behavior", module: "local", owner: "primary-ai",
  writeScopes: ["sample.mjs", "solution.md"], verification: ["node --version"],
  docsImpact: ["N/A: current contract remains correct"], risk: "medium", reviewBatch: "R1",
};

async function intake(root, { type = "ITERATION", flags = [], authorizationMode = "autonomous" } = {}) {
  await createWorkItemState(root, {
    id, type, title: "preserve behavior while handling boundary input", flags,
    references: ["user request"], acceptance: ["boundary inputs work; existing inputs remain compatible"],
    nonGoals: ["deployment"], authorizationMode, authorizationSource: "user's bounded task request",
    ...(type === "BUGFIX" ? { bug: { actual: "wrong result", expected: "documented result", reproduction: "run the local example" } } : {}),
  });
}

async function preparePlan(root, options = {}) {
  await intake(root, options);
  await transitionWorkItem(root, id, "BASELINING");
  await completeBaseline(root, id, { evidence: ["temporary repository inspected"] });
  await transitionWorkItem(root, id, "SOLUTION_DESIGN");
  await writeFile(path.join(root, "solution.md"), "# Solution\n\nPreserve the local contract.\n");
  await completeSolution(root, id, { document: "solution.md", evidence: ["bounded flow reviewed"] });
  await setDatabaseDecision(root, id, { impact: "none", evidence: ["no persistence"] });
  await initializePlan(root, id, { mode: options.multi ? "multi" : "single", rationale: "bounded ownership" });
  await addReviewBatch(root, id, { id: "R1", title: "local behavior", risk: "medium", independentRequired: Boolean(options.independent) });
  await addTask(root, id, taskOptions);
  if (options.multi || options.dependent) await addTask(root, id, {
    ...taskOptions, id: "T2", owner: options.multi ? "other-ai" : "primary-ai",
    writeScopes: ["other.mjs"], blockedBy: options.dependent ? ["T1"] : [],
  });
}

async function implementing(root, options = {}) {
  await preparePlan(root, options);
  await approvePlan(root, id, "actual task authorization");
  await transitionWorkItem(root, id, "PLANNED");
  await transitionWorkItem(root, id, "IMPLEMENTING");
  await updateTaskStatus(root, id, "T1", "IN_PROGRESS");
}

async function run(root, args = ["--version"], taskId = "T1") {
  return runRecordedCommand(root, { id, taskId, command: process.execPath, args });
}

async function completeTask(root) {
  const command = await run(root);
  await recordResult(root, id, { taskId: "T1", kind: "verification", status: "pass", summary: `fixture command ${command.id}` });
  await updateTaskStatus(root, id, "T1", "IMPLEMENTED");
  await updateTaskStatus(root, id, "T1", "IN_REVIEW");
  await recordResult(root, id, { taskId: "T1", kind: "review", status: "pass", summary: "fixture review" });
  await updateTaskStatus(root, id, "T1", "COMPLETED");
  return command;
}

async function snapshot(root) {
  const paths = await workItemPaths(root, id);
  return Promise.all([paths.state, paths.plan, paths.evidence, paths.events].map(async (file) => (await exists(file)) ? readFile(file, "utf8") : null));
}

test("guide restores goals and scope without changing state or granting completion", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root);
    const before = await snapshot(root);
    const guide = await getWorkGuide(root, id);
    assert.deepEqual(await snapshot(root), before);
    assert.deepEqual(guide.workItem.nonGoals, ["deployment"]);
    assert.deepEqual(guide.task.writeScopes, taskOptions.writeScopes);
    assert.deepEqual(guide.task.verification, taskOptions.verification);
    assert.equal(guide.resources.solution, "solution.md");
    assert.equal(guide.next.code, "implement-and-verify");
    assert.equal(guide.next.requiresJudgment, true);
    assert.ok(guide.next.command.args.includes("--check"));
    assert.ok(guide.next.command.args.includes("V1"));
    assert.equal(guide.next.command.args.includes("--status"), false);
  } finally { await cleanup(root); }
});

test("guide follows verification and review gates while leaving verdicts to the caller", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root);
    const command = await run(root);
    let guide = await getWorkGuide(root, id);
    assert.equal(guide.next.code, "record-verification");
    assert.ok(guide.next.command.args.includes("<RESULT_STATUS>"));
    assert.equal(guide.evidence.commands[0].id, command.id);
    await recordResult(root, id, { taskId: "T1", kind: "verification", status: "pass", summary: `checked command ${command.id}` });
    guide = await getWorkGuide(root, id);
    assert.equal(guide.next.taskTarget, "IMPLEMENTED");
    assert.equal(guide.next.requiresJudgment, false);
    await updateTaskStatus(root, id, "T1", guide.next.taskTarget);
    guide = await getWorkGuide(root, id);
    assert.equal(guide.next.taskTarget, "IN_REVIEW");
    await updateTaskStatus(root, id, "T1", guide.next.taskTarget);
    assert.equal((await getWorkGuide(root, id)).next.code, "record-review");
    await recordResult(root, id, { taskId: "T1", kind: "review", status: "fail", summary: "counterexample found" });
    guide = await getWorkGuide(root, id);
    assert.equal(guide.next.taskTarget, "REWORK");
    assert.equal(guide.evidence.latestResult.status, "fail");
    await updateTaskStatus(root, id, "T1", "REWORK");
    await updateTaskStatus(root, id, "T1", "IN_PROGRESS");
    guide = await getWorkGuide(root, id);
    assert.equal(guide.evidence.commands.length, 0);
    assert.equal(guide.next.code, "implement-and-verify");
  } finally { await cleanup(root); }
});

test("guide prioritizes real failures, redacts previews and marks truncation", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root);
    const token = "sk-" + "testonly".repeat(12);
    await writeFile(path.join(root, "sample.mjs"), `const broken = ${token}${"x".repeat(1800)} @\n`);
    const failed = await run(root, ["--check", "sample.mjs"]);
    assert.equal(failed.status, "fail");
    for (let i = 0; i < 6; i += 1) {
      const file = `example-${i}.mjs`;
      await writeFile(path.join(root, file), "const valid = 1;\n");
      await run(root, ["--check", file]);
    }
    const guide = await getWorkGuide(root, id);
    assert.equal(guide.next.code, "implement-and-verify");
    assert.equal(guide.evidence.commands[0].id, failed.id);
    assert.equal(guide.evidence.commands.length, 5);
    assert.equal(guide.evidence.omittedCommands, 2);
    assert.equal(JSON.stringify(guide).includes(token), false);
    assert.ok(guide.evidence.commands[0].stderr.sha256);
    await recordResult(root, id, { taskId: "T1", kind: "verification", status: "fail", summary: "detail ".repeat(400) });
    const summarized = await getWorkGuide(root, id);
    assert.equal(summarized.evidence.latestResult.summary.truncated, true);
    assert.ok(summarized.evidence.latestResult.summary.text.length < 1250);
  } finally { await cleanup(root); }
});

test("guide never borrows a different task's successful command", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root, { dependent: true });
    await completeTask(root);
    await updateTaskStatus(root, id, "T2", "IN_PROGRESS");
    const guide = await getWorkGuide(root, id, { taskId: "T2" });
    assert.equal(guide.evidence.commands.length, 0);
    assert.equal(guide.next.code, "implement-and-verify");
  } finally { await cleanup(root); }
});

test("dependency and ownership decisions do not unlock or take over other tasks", async () => {
  const root = await createInstalledProject();
  const team = await createInstalledProject();
  try {
    await implementing(root, { dependent: true });
    const dependent = await getWorkGuide(root, id, { taskId: "T2" });
    assert.equal(dependent.next.command, null);
    assert.equal(dependent.task.status, "PENDING");
    assert.equal((await getWorkGuide(root, id)).task.id, "T1");
    await implementing(team, { multi: true, flags: ["multi-agent"] });
    const guide = await getWorkGuide(team, id);
    assert.equal(guide.task, null);
    assert.equal(guide.next.code, "select-task");
    assert.equal(guide.next.command, null);
    await completeTask(team);
    assert.equal((await getWorkGuide(team, id)).task, null);
    assert.equal((await getWorkGuide(team, id, { taskId: "T2" })).task.owner, "other-ai");
  } finally { await cleanup(root); await cleanup(team); }
});

test("blocked guidance describes the condition before suggesting the recorded resume state", async () => {
  const root = await createInstalledProject();
  try {
    await intake(root);
    await transitionWorkItem(root, id, "BLOCKED", "required input is missing");
    const before = await snapshot(root);
    const guide = await getWorkGuide(root, id);
    assert.equal(guide.next.code, "resolve-blocker");
    assert.equal(guide.next.requiresJudgment, true);
    assert.ok(guide.next.command.args.includes("INTAKE"));
    assert.equal(guide.evidence.blocker.reason, "required input is missing");
    assert.deepEqual(await snapshot(root), before);
  } finally { await cleanup(root); }
});

test("resolved task blockers do not remain active in recovery context", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root);
    await updateTaskStatus(root, id, "T1", "BLOCKED", { reason: "local input missing" });
    let guide = await getWorkGuide(root, id);
    assert.equal(guide.evidence.blocker.reason, "local input missing");
    assert.equal(guide.next.requiresJudgment, true);
    await updateTaskStatus(root, id, "T1", "READY");
    await updateTaskStatus(root, id, "T1", "IN_PROGRESS");
    guide = await getWorkGuide(root, id);
    assert.equal(guide.evidence.blocker, null);
    assert.equal(guide.next.code, "implement-and-verify");
  } finally { await cleanup(root); }
});

for (const authorizationMode of ["autonomous", "approval-required"]) {
  test(`plan guidance preserves ${authorizationMode} authorization`, async () => {
    const root = await createInstalledProject();
    try {
      await preparePlan(root, { authorizationMode });
      const guide = await getWorkGuide(root, id);
      assert.equal(guide.next.code, "approve-plan");
      assert.equal(guide.next.requiresHumanApproval, authorizationMode === "approval-required");
      assert.ok(guide.next.command.args.includes(authorizationMode === "autonomous" ? "user's bounded task request" : "<HUMAN_APPROVAL>"));
      assert.equal((await loadWorkItem(root, id)).plan.approved, false);
    } finally { await cleanup(root); }
  });
}

for (const [type, flags, stages] of [
  ["BUGFIX", ["frontend"], ["static", "sandbox", "reproduction", "regression", "browser"]],
  ["ITERATION", ["codegen", "frontend"], ["static", "sandbox", "contract", "eval", "browser"]],
]) {
  test(`guide requires actual ordered pipeline evidence for ${type} ${flags.join("/")}`, async () => {
    const root = await createInstalledProject();
    try {
      await implementing(root, { type, flags });
      const command = await completeTask(root);
      await transitionWorkItem(root, id, "VERIFYING");
      for (const stage of stages) {
        const guide = await getWorkGuide(root, id);
        assert.equal(guide.next.code, "record-verification");
        assert.equal(guide.next.command.args[guide.next.command.args.indexOf("--stage") + 1], stage);
        assert.ok(guide.next.command.args.includes("<ACTUAL_EVIDENCE>"));
        assert.equal(guide.next.requiresJudgment, true);
        const runBacked = ["reproduction", "regression"].includes(stage);
        if (runBacked) assert.equal(guide.next.command.args[guide.next.command.args.indexOf("--command") + 1], command.id);
        await recordResult(root, id, { kind: "verification", status: "pass", summary: `${stage} external fixture`, stage, commandRef: runBacked ? command.id : null });
      }
      assert.equal((await getWorkGuide(root, id)).next.code, "record-documentation");
    } finally { await cleanup(root); }
  });
}

test("guide keeps final independent review and acceptance explicit", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root, { independent: true });
    await completeTask(root);
    await transitionWorkItem(root, id, "VERIFYING");
    await recordResult(root, id, { kind: "verification", status: "pass", summary: "fixture suite checked" });
    await recordResult(root, id, { kind: "documentation", status: "not-applicable", summary: "existing contract still correct" });
    await transitionWorkItem(root, id, "CODE_REVIEW");
    let guide = await getWorkGuide(root, id);
    assert.equal(guide.next.requiresIndependentReview, true);
    assert.ok(guide.next.command.args.includes("--independent"));
    assert.equal((await loadWorkItem(root, id)).review.independent, false);
    await recordResult(root, id, { kind: "review", status: "pass", summary: "independent review fixture", independent: true });
    guide = await getWorkGuide(root, id);
    assert.equal(guide.next.workTarget, "READY_FOR_ACCEPTANCE");
    await transitionWorkItem(root, id, guide.next.workTarget);
    assert.equal((await getWorkGuide(root, id)).next.code, "record-acceptance");
    await recordResult(root, id, { kind: "acceptance", status: "pass", summary: "actual acceptance fixture" });
    await transitionWorkItem(root, id, "DONE");
    guide = await getWorkGuide(root, id);
    assert.equal(guide.next.code, "check-delivery");
    assert.deepEqual(guide.next.command.args, [".ai-harness/bin/harness.mjs", "check", "--ci", "--json"]);
  } finally { await cleanup(root); }
});

test("analysis guidance advances without creating a product editing task", async () => {
  const root = await createInstalledProject();
  try {
    await intake(root, { type: "ANALYSIS", authorizationMode: "approval-required" });
    assert.equal((await getWorkGuide(root, id)).next.workTarget, "BASELINING");
    await transitionWorkItem(root, id, "BASELINING");
    assert.equal((await getWorkGuide(root, id)).next.code, "inspect-baseline");
    await completeBaseline(root, id, { evidence: ["actual checkout inspected"] });
    assert.equal((await getWorkGuide(root, id)).next.workTarget, "ANALYZING");
    await transitionWorkItem(root, id, "ANALYZING");
    assert.equal((await getWorkGuide(root, id)).next.code, "analyze-evidence");
    await addAnalysisConclusion(root, id, { status: "PROVEN", text: "runtime exists", evidence: [".ai-harness/manifest.json"] });
    assert.equal((await getWorkGuide(root, id)).next.code, "record-analysis");
    await recordResult(root, id, { kind: "analysis", status: "pass", summary: "question answered from code" });
    assert.equal((await getWorkGuide(root, id)).next.workTarget, "ANSWERED");
    assert.equal((await getWorkGuide(root, id)).task, null);
  } finally { await cleanup(root); }
});

test("invalid or foreign evidence fails explicitly rather than becoming guidance", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root);
    await assert.rejects(() => getWorkGuide(root, id, { taskId: "missing" }), { code: "TASK_NOT_FOUND" });
    const paths = await workItemPaths(root, id);
    await writeFile(paths.evidence, "{invalid}\n");
    await assert.rejects(() => getWorkGuide(root, id), { code: "INVALID_GUIDE_EVIDENCE" });
    await writeFile(paths.evidence, JSON.stringify({ id: "foreign", workItemId: "OTHER", timestamp: new Date().toISOString() }) + "\n");
    await assert.rejects(() => getWorkGuide(root, id), { code: "INVALID_GUIDE_EVIDENCE" });
    assert.equal((await loadWorkItem(root, id)).status, "IMPLEMENTING");
  } finally { await cleanup(root); }
});

test("planning guidance waits for database design before proposing an implementation plan", async () => {
  const root = await createInstalledProject();
  try {
    await intake(root);
    await transitionWorkItem(root, id, "BASELINING");
    await completeBaseline(root, id, { evidence: ["actual checkout inspected"] });
    await transitionWorkItem(root, id, "SOLUTION_DESIGN");
    assert.equal((await getWorkGuide(root, id)).next.code, "design-solution");
    await writeFile(path.join(root, "solution.md"), "# Design\n\nDatabase fixture.\n");
    await completeSolution(root, id, { document: "solution.md", evidence: ["flow designed"] });
    assert.equal((await getWorkGuide(root, id)).next.code, "assess-database");
    await setDatabaseDecision(root, id, { impact: "required", evidence: ["query changes"] });
    assert.equal((await getWorkGuide(root, id)).next.workTarget, "DATABASE_DESIGN");
    await transitionWorkItem(root, id, "DATABASE_DESIGN");
    assert.equal((await getWorkGuide(root, id)).next.code, "design-database");
    await setDatabaseDecision(root, id, { impact: "required", complete: true, document: "solution.md", evidence: ["database design fixture complete"] });
    assert.equal((await getWorkGuide(root, id)).next.code, "create-plan");
    await initializePlan(root, id, { mode: "single", rationale: "one task" });
    assert.equal((await getWorkGuide(root, id)).next.code, "plan-review");
    await addReviewBatch(root, id, { id: "R1", title: "review", risk: "medium", independentRequired: false });
    assert.equal((await getWorkGuide(root, id)).next.code, "plan-task");
    await addTask(root, id, taskOptions);
    assert.equal((await getWorkGuide(root, id)).next.code, "approve-plan");
    await approvePlan(root, id, "actual authorization");
    assert.equal((await getWorkGuide(root, id)).next.workTarget, "PLANNED");
    await transitionWorkItem(root, id, "PLANNED");
    assert.equal((await getWorkGuide(root, id)).next.workTarget, "IMPLEMENTING");
  } finally { await cleanup(root); }
});

test("inconsistent persisted progress never produces a next-step recommendation", async () => {
  const root = await createInstalledProject();
  try {
    await implementing(root);
    const paths = await workItemPaths(root, id);
    const state = JSON.parse(await readFile(paths.state, "utf8"));
    state.status = "DONE";
    await writeFile(paths.state, JSON.stringify(state));
    await assert.rejects(() => getWorkGuide(root, id), { code: "GUIDE_STATE_INVALID" });
  } finally { await cleanup(root); }
});
