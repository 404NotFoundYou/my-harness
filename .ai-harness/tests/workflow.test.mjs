import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { cleanup, createInstalledProject } from "./helpers.mjs";
import { checkProject } from "../src/checker.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import {
  addAnalysisConclusion,
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

test("iteration completes only through solution, database, plan, task, review and acceptance gates", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "ITER-1",
      type: "ITERATION",
      title: "workflow test",
      references: ["approved requirement"],
      acceptance: ["all gates pass"],
      nonGoals: ["deployment"],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
    });
    await assert.rejects(() => transitionWorkItem(root, "ITER-1", "PLANNED"), { code: "INVALID_TRANSITION" });
    await transitionWorkItem(root, "ITER-1", "BASELINING");
    await completeBaseline(root, "ITER-1", { evidence: ["temporary git baseline"] });
    await transitionWorkItem(root, "ITER-1", "SOLUTION_DESIGN");
    await writeFile(path.join(root, "solution.md"), "# Solution\n\nNo database changes.\n", "utf8");
    await completeSolution(root, "ITER-1", { document: "solution.md", evidence: ["approved flow and API sketch"] });
    await setDatabaseDecision(root, "ITER-1", { impact: "none", evidence: ["no persistence path changes"] });
    await initializePlan(root, "ITER-1", { mode: "single", rationale: "one bounded task" });
    await addReviewBatch(root, "ITER-1", { id: "R1", title: "workflow", risk: "medium", independentRequired: false });
    await addTask(root, "ITER-1", {
      id: "T1",
      title: "verify runtime",
      module: "runtime",
      blockedBy: [],
      writeScopes: ["solution.md"],
      verification: ["node --version"],
      docsImpact: ["solution.md"],
      reviewBatch: "R1",
      risk: "medium",
      owner: "test",
    });
    await approvePlan(root, "ITER-1", "test authorization");
    await transitionWorkItem(root, "ITER-1", "PLANNED");
    await transitionWorkItem(root, "ITER-1", "IMPLEMENTING");
    await updateTaskStatus(root, "ITER-1", "T1", "IN_PROGRESS");
    const command = await runRecordedCommand(root, { id: "ITER-1", taskId: "T1", command: process.execPath, args: ["--version"] });
    assert.equal(command.status, "pass");
    await recordResult(root, "ITER-1", { kind: "verification", status: "pass", summary: `command ${command.id}`, taskId: "T1" });
    await updateTaskStatus(root, "ITER-1", "T1", "IMPLEMENTED");
    await updateTaskStatus(root, "ITER-1", "T1", "IN_REVIEW");
    await recordResult(root, "ITER-1", { kind: "review", status: "pass", summary: "task diff reviewed", taskId: "T1" });
    await updateTaskStatus(root, "ITER-1", "T1", "COMPLETED");
    await transitionWorkItem(root, "ITER-1", "VERIFYING");
    await recordResult(root, "ITER-1", { kind: "verification", status: "pass", summary: "work-item verification passed" });
    await recordResult(root, "ITER-1", { kind: "documentation", status: "pass", summary: "solution documentation current" });
    await transitionWorkItem(root, "ITER-1", "CODE_REVIEW");
    await recordResult(root, "ITER-1", { kind: "review", status: "pass", summary: "final diff reviewed" });
    await transitionWorkItem(root, "ITER-1", "READY_FOR_ACCEPTANCE");
    await recordResult(root, "ITER-1", { kind: "acceptance", status: "pass", summary: "authorized test acceptance" });
    const done = await transitionWorkItem(root, "ITER-1", "DONE");
    assert.equal(done.status, "DONE");
    const check = await checkProject(root, { ci: true });
    assert.deepEqual(check.errors, []);
  } finally {
    await cleanup(root);
  }
});

test("analysis uses evidence statuses and ends at ANSWERED without development gates", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "ANALYSIS-1",
      type: "ANALYSIS",
      title: "current implementation",
      references: ["user question"],
      acceptance: ["evidence-backed answer"],
      nonGoals: ["code changes"],
      authorizationMode: "approval-required",
      authorizationSource: "read-only question",
    });
    await transitionWorkItem(root, "ANALYSIS-1", "BASELINING");
    await completeBaseline(root, "ANALYSIS-1", { evidence: ["current checkout inspected"] });
    await transitionWorkItem(root, "ANALYSIS-1", "ANALYZING");
    await addAnalysisConclusion(root, "ANALYSIS-1", { status: "PROVEN", text: "runtime is installed", evidence: [".ai-harness/manifest.json"] });
    await addAnalysisConclusion(root, "ANALYSIS-1", { status: "UNKNOWN", text: "production deployment is unknown", evidence: [], unknown: "no production access" });
    await recordResult(root, "ANALYSIS-1", { kind: "analysis", status: "pass", summary: "answer separates proven and unknown facts" });
    const answered = await transitionWorkItem(root, "ANALYSIS-1", "ANSWERED");
    assert.equal(answered.status, "ANSWERED");
    assert.equal((await loadWorkItem(root, "ANALYSIS-1")).database.impact, "unknown");
  } finally {
    await cleanup(root);
  }
});

test("new projects require an approved architecture source", async () => {
  const root = await createInstalledProject({ mode: "new", docsMode: "default" });
  try {
    const base = {
      id: "NEW-1",
      type: "NEW_PROJECT",
      title: "new project",
      references: ["approved PRD"],
      acceptance: ["project boots"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
    };
    await assert.rejects(() => createWorkItemState(root, base), { code: "ARCHITECTURE_SOURCE_REQUIRED" });
    await assert.rejects(
      () => createWorkItemState(root, { ...base, architectureSource: "AI_RECOMMENDED" }),
      { code: "ARCHITECTURE_APPROVAL_REQUIRED" },
    );
    const item = await createWorkItemState(root, {
      ...base,
      architectureSource: "AI_RECOMMENDED",
      architectureApproval: "user approved architecture",
    });
    assert.equal(item.architecture.source, "AI_RECOMMENDED");
    assert.equal(item.input.version, "v1.0");
  } finally {
    await cleanup(root);
  }
});

test("bug fixes require actual, expected and reproduction details", async () => {
  const root = await createInstalledProject();
  try {
    const base = {
      id: "BUG-1",
      type: "BUGFIX",
      title: "repair behavior",
      references: ["issue"],
      acceptance: ["reproduction passes"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
    };
    await assert.rejects(() => createWorkItemState(root, base), { code: "BUG_BASELINE_REQUIRED" });
    const item = await createWorkItemState(root, {
      ...base,
      bug: {
        actual: "returns 500",
        expected: "returns 200",
        reproduction: "call GET /health",
      },
    });
    assert.equal(item.bug.reproduction, "call GET /health");
  } finally {
    await cleanup(root);
  }
});

test("flags deterministically select policy files", async () => {
  const root = await createInstalledProject();
  try {
    const item = await createWorkItemState(root, {
      id: "ITER-FLAGS",
      type: "ITERATION",
      title: "frontend API iteration",
      references: ["approved PRD"],
      acceptance: ["feature works"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
      flags: ["frontend", "api", "frontend"],
    });
    assert.deepEqual(item.flags, ["frontend", "api"]);
    assert.deepEqual(item.policyFiles, [
      ".ai-harness/policies/core.md",
      ".ai-harness/policies/security.md",
      ".ai-harness/policies/documentation.md",
      ".ai-harness/policies/iteration.md",
      ".ai-harness/policies/database.md",
      ".ai-harness/policies/frontend.md",
      ".ai-harness/policies/api.md",
    ]);
  } finally {
    await cleanup(root);
  }
});

test("required database impact cannot reach planning before design completes", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "ITER-DB",
      type: "ITERATION",
      title: "database iteration",
      references: ["approved PRD"],
      acceptance: ["schema supports queries"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
      flags: ["database"],
    });
    await transitionWorkItem(root, "ITER-DB", "BASELINING");
    await completeBaseline(root, "ITER-DB", { evidence: ["git baseline"] });
    await transitionWorkItem(root, "ITER-DB", "SOLUTION_DESIGN");
    await writeFile(path.join(root, "solution.md"), "# Solution\n", "utf8");
    await completeSolution(root, "ITER-DB", { document: "solution.md", evidence: ["business flow"] });
    await setDatabaseDecision(root, "ITER-DB", { impact: "required", evidence: ["new persistence path"] });
    await transitionWorkItem(root, "ITER-DB", "DATABASE_DESIGN");
    await assert.rejects(
      () => transitionWorkItem(root, "ITER-DB", "PLANNED"),
      { code: "GATE_INCOMPLETE" },
    );
    await writeFile(path.join(root, "database.md"), "# Database\n", "utf8");
    await setDatabaseDecision(root, "ITER-DB", {
      impact: "required",
      document: "database.md",
      evidence: ["queries and indexes documented"],
      complete: true,
    });
    await assert.rejects(
      () => transitionWorkItem(root, "ITER-DB", "PLANNED"),
      { code: "PLAN_REQUIRED" },
    );
  } finally {
    await cleanup(root);
  }
});

test("result evidence cannot be recorded before its workflow stage", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "ITER-STAGE",
      type: "ITERATION",
      title: "stage evidence",
      references: ["approved PRD"],
      acceptance: ["gates are ordered"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
    });
    await assert.rejects(
      () => recordResult(root, "ITER-STAGE", { kind: "acceptance", status: "pass", summary: "premature" }),
      { code: "WRONG_STAGE" },
    );
  } finally {
    await cleanup(root);
  }
});

test("multi-agent plans require the multi-agent policy flag", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "ITER-MULTI",
      type: "ITERATION",
      title: "parallel work",
      references: ["approved PRD"],
      acceptance: ["plan is isolated"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
    });
    await transitionWorkItem(root, "ITER-MULTI", "BASELINING");
    await completeBaseline(root, "ITER-MULTI", { evidence: ["git baseline"] });
    await transitionWorkItem(root, "ITER-MULTI", "SOLUTION_DESIGN");
    await writeFile(path.join(root, "solution.md"), "# Solution\n", "utf8");
    await completeSolution(root, "ITER-MULTI", { document: "solution.md", evidence: ["module boundaries"] });
    await setDatabaseDecision(root, "ITER-MULTI", { impact: "none", evidence: ["no persistence changes"] });
    await assert.rejects(
      () => initializePlan(root, "ITER-MULTI", { mode: "multi", rationale: "parallel modules" }),
      { code: "MULTI_AGENT_POLICY_REQUIRED" },
    );
  } finally {
    await cleanup(root);
  }
});

test("development baselines require an initial Git commit", async () => {
  const root = await createInstalledProject({ commit: false });
  try {
    await createWorkItemState(root, {
      id: "ITER-NO-COMMIT",
      type: "ITERATION",
      title: "missing Git baseline",
      references: ["approved PRD"],
      acceptance: ["scope can be verified"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
    });
    await transitionWorkItem(root, "ITER-NO-COMMIT", "BASELINING");
    await assert.rejects(
      () => completeBaseline(root, "ITER-NO-COMMIT", { evidence: ["uncommitted repository"] }),
      { code: "GIT_COMMIT_REQUIRED" },
    );
  } finally {
    await cleanup(root);
  }
});
