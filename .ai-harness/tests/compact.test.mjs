import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { beginWorkItem, finishWorkItem } from "../src/compact.mjs";
import { checkProject } from "../src/checker.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { exists } from "../src/filesystem.mjs";
import { loadPlan, loadWorkItem, recordResult, updateTaskStatus, workItemPaths } from "../src/workflow.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

function options(overrides = {}) {
  return {
    id: "COMPACT-1", type: "ITERATION", title: "bounded local change",
    references: ["user requests local implementation"], acceptance: ["regression verified"],
    authorizationMode: "autonomous", authorizationSource: "user task authorization",
    risk: "medium", approach: "Update the local behavior and its regression check.",
    databaseEvidence: "No persistence or query changes.",
    writeScopes: ["feature.test.mjs"], verification: ["node --version"],
    docsImpact: ["N/A: existing behavior remains documented"], ...overrides,
  };
}

function results(commandIds, overrides = {}) {
  return {
    commandIds, verification: "The regression command passes.",
    review: "Reviewed the complete diff and affected callers.",
    documentation: "N/A: existing documentation remains correct",
    acceptance: "The requested behavior and regression meet the acceptance criteria.", ...overrides,
  };
}

function bugStages(commandId) {
  return {
    stageEvidence: ["static=static-check fixture", "sandbox=isolated-execution fixture", "reproduction=local regression executed", "regression=local suite executed"],
    stageCommands: [`reproduction=${commandId}`, `regression=${commandId}`],
  };
}

async function run(root, id = "COMPACT-1", args = ["--version"]) {
  // Child verification must really execute, not inherit the parent's test-runner marker.
  const testContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    return await runRecordedCommand(root, { id, taskId: "T1", command: process.execPath, args });
  } finally {
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }
}

for (const type of ["ITERATION", "BUGFIX"]) {
  test(`compact ${type} keeps auditable gates without manual state bookkeeping`, async () => {
    const root = await createInstalledProject();
    try {
      const started = await beginWorkItem(root, options({
        type,
        verification: ["node --test feature.test.mjs"],
        ...(type === "BUGFIX" ? { bug: { actual: "wrong local result", expected: "documented result", reproduction: "run the local regression" } } : {}),
      }));
      assert.equal(started.status, "IMPLEMENTING");
      assert.equal((await loadPlan(root, started.id)).tasks[0].status, "IN_PROGRESS");
      await writeFile(path.join(root, "feature.test.mjs"), 'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\n');
      const command = await run(root, started.id, ["--test", "feature.test.mjs"]);
      assert.equal(command.status, "pass");
      assert.equal((await finishWorkItem(root, started.id, results([command.id], type === "BUGFIX" ? bugStages(command.id) : {}))).status, "DONE");
      const item = await loadWorkItem(root, started.id);
      assert.equal(item.review.independent, false);
      assert.equal(item.documentation.status, "not-applicable");
      if (type === "BUGFIX") {
        assert.deepEqual(item.verification.stages.map((stage) => stage.stage), ["static", "sandbox", "reproduction", "regression"]);
        assert.equal(item.verification.stages.find((stage) => stage.stage === "regression").command, command.id);
      }
      assert.deepEqual(item.history.map((entry) => entry.to), [
        "INTAKE", "BASELINING", "SOLUTION_DESIGN", "PLANNED", "IMPLEMENTING",
        "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE",
      ]);
      assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
    } finally {
      await cleanup(root);
    }
  });
}

test("compact startup rejects ineligible or incomplete work before leaving state behind", async () => {
  const root = await createInstalledProject();
  try {
    for (const overrides of [
      { risk: "high" }, { risk: "unknown" }, { type: "NEW_PROJECT" }, { type: "ANALYSIS" },
      ...["database", "api", "mobile", "multi-agent", "codegen"].map((flag) => ({ flags: [flag] })),
      { authorizationMode: "approval-required" }, { authorizationSource: "" },
      { type: "BUGFIX", bug: null }, { approach: "" }, { databaseEvidence: "" },
      { writeScopes: ["**"] }, { verification: [] }, { docsImpact: [] },
    ]) {
      await assert.rejects(() => beginWorkItem(root, options(overrides)));
      assert.equal(await exists(path.join(root, ".ai-harness/work-items/COMPACT-1")), false);
    }
  } finally {
    await cleanup(root);
  }
});

test("unfinished work and out-of-scope edits cannot acquire a successful compact completion", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options());
    assert.equal((await checkProject(root, { ci: true })).ok, false);
    await writeFile(path.join(root, "outside.txt"), "unplanned change");
    const command = await run(root);
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id])), { code: "CHECK_FAILED" });
    assert.equal((await loadWorkItem(root, "COMPACT-1")).verification.status, "pending");
  } finally {
    await cleanup(root);
  }
});

test("compact completion requires explicit review, acceptance and real current-task evidence", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options());
    await beginWorkItem(root, options({ id: "OTHER-1" }));
    const foreign = await run(root, "OTHER-1");
    for (const commandIds of [["invented-id"], [foreign.id]]) {
      await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results(commandIds)), { code: "COMMAND_EVIDENCE_INVALID" });
    }
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([])), { code: "COMMAND_EVIDENCE_REQUIRED" });
    const command = await run(root);
    for (const field of ["verification", "review", "documentation", "acceptance"]) {
      await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id], { [field]: "" })), { code: "RESULT_REQUIRED" });
    }
    assert.equal((await loadWorkItem(root, "COMPACT-1")).status, "IMPLEMENTING");
    assert.equal((await loadPlan(root, "COMPACT-1")).tasks[0].verificationStatus, "pending");
  } finally {
    await cleanup(root);
  }
});

test("a successful unrelated command cannot conceal a failing regression", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options({ verification: ["node --test feature.test.mjs"] }));
    const file = path.join(root, "feature.test.mjs");
    await writeFile(file, 'throw new Error("regression");\n');
    const failed = await run(root, "COMPACT-1", ["--test", "feature.test.mjs"]);
    assert.equal(failed.status, "fail", JSON.stringify(failed.command));
    const unrelated = await run(root);
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([unrelated.id])), { code: "VERIFICATION_NOT_CURRENT" });
    await writeFile(file, 'import assert from "node:assert/strict";\nassert.equal(2 + 2, 4);\n');
    const passed = await run(root, "COMPACT-1", ["--test", "feature.test.mjs"]);
    assert.equal((await finishWorkItem(root, "COMPACT-1", results([passed.id]))).status, "DONE");
  } finally {
    await cleanup(root);
  }
});

test("repeating a successful check does not invalidate identical current evidence", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options());
    const old = await run(root);
    await run(root);
    assert.equal((await finishWorkItem(root, "COMPACT-1", results([old.id]))).status, "DONE");
  } finally {
    await cleanup(root);
  }
});

test("rework requires a new command run rather than recycling the previous attempt", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options());
    const old = await run(root);
    await recordResult(root, "COMPACT-1", { taskId: "T1", kind: "verification", status: "pass", summary: `command ${old.id}` });
    await updateTaskStatus(root, "COMPACT-1", "T1", "IMPLEMENTED");
    await updateTaskStatus(root, "COMPACT-1", "T1", "REWORK");
    await updateTaskStatus(root, "COMPACT-1", "T1", "IN_PROGRESS");
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([old.id])), { code: "VERIFICATION_NOT_CURRENT" });
    const current = await run(root);
    assert.equal((await finishWorkItem(root, "COMPACT-1", results([current.id]))).status, "DONE");
  } finally {
    await cleanup(root);
  }
});

test("compact finish cannot take over work requiring independent review", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options());
    const command = await run(root);
    const paths = await workItemPaths(root, "COMPACT-1");
    const plan = JSON.parse(await readFile(paths.plan, "utf8"));
    plan.reviewBatches[0].independentRequired = true;
    await writeFile(paths.plan, JSON.stringify(plan));
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id])), { code: "FULL_WORKFLOW_REQUIRED" });
    assert.equal((await loadWorkItem(root, "COMPACT-1")).status, "IMPLEMENTING");
  } finally {
    await cleanup(root);
  }
});

test("compact frontend bug requires all pipeline evidence before changing any result", async () => {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options({
      type: "BUGFIX", flags: ["frontend"],
      bug: { actual: "wrong display", expected: "documented display", reproduction: "open the affected view" },
    }));
    const command = await run(root);
    const stages = bugStages(command.id);
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id])), { code: "VERIFICATION_STAGE_REQUIRED" });
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id], stages)), { code: "VERIFICATION_STAGE_REQUIRED" });
    stages.stageEvidence.push("browser=external browser-probe fixture");
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id], { ...stages, stageCommands: [] })), { code: "STAGE_RUN_REQUIRED" });
    await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id], { ...stages, stageCommands: ["reproduction=missing", `regression=${command.id}`] })), { code: "COMMAND_EVIDENCE_INVALID" });
    for (const extra of ["unknown=invalid", "static=duplicate", "=empty-stage"]) {
      await assert.rejects(() => finishWorkItem(root, "COMPACT-1", results([command.id], { ...stages, stageEvidence: [...stages.stageEvidence, extra] })), { code: "STAGE_INPUT_INVALID" });
    }
    assert.equal((await loadWorkItem(root, "COMPACT-1")).status, "IMPLEMENTING");
    assert.equal((await loadPlan(root, "COMPACT-1")).tasks[0].verificationStatus, "pending");
    assert.equal((await finishWorkItem(root, "COMPACT-1", results([command.id], stages))).status, "DONE");
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
  } finally {
    await cleanup(root);
  }
});
