import test from "node:test";
import assert from "node:assert/strict";
import { createPlan, createReviewBatch, createTask, createWorkItem } from "../src/model.mjs";
import { collectPlanErrors, fileMatchesScope, assertTransitionAllowed } from "../src/validator.mjs";

function item(type = "ITERATION") {
  return createWorkItem({
    id: "WORK-1",
    type,
    title: "test",
    references: ["input"],
    acceptance: ["passes"],
    nonGoals: [],
    authorizationMode: "autonomous",
    authorizationSource: "test",
  });
}

test("state transition graph blocks skipped gates", () => {
  const workItem = item();
  assert.deepEqual(workItem.policyFiles, [".ai-harness/policies/core.md"]);
  assert.throws(() => assertTransitionAllowed(workItem, "PLANNED"), { code: "INVALID_TRANSITION" });
  assert.doesNotThrow(() => assertTransitionAllowed(workItem, "BASELINING"));
});

test("plan validator catches cycles and missing independent review", () => {
  const plan = createPlan({ workItemId: "WORK-1", mode: "single", rationale: "test" });
  plan.reviewBatches.push(createReviewBatch({ id: "R1", title: "core", risk: "high", independentRequired: false }));
  const first = createTask({
    id: "T1", title: "first", module: "core", blockedBy: [], writeScopes: ["src/a/**"], verification: ["test"], docsImpact: ["N/A: no behavior docs"], reviewBatch: "R1", risk: "high", owner: "ai",
  });
  const second = createTask({
    id: "T2", title: "second", module: "core", blockedBy: ["T1"], writeScopes: ["src/b/**"], verification: ["test"], docsImpact: ["N/A: no behavior docs"], reviewBatch: "R1", risk: "medium", owner: "ai",
  });
  first.blockedBy.push("T2");
  first.blocks.push("T2");
  second.blocks.push("T1");
  plan.tasks.push(first, second);
  plan.reviewBatches[0].taskIds.push("T1", "T2");
  const errors = collectPlanErrors(plan, "WORK-1");
  assert.ok(errors.some((message) => message.includes("存在环")));
  assert.ok(errors.some((message) => message.includes("独立复核")));
});

test("multi-agent plan rejects overlapping unordered write scopes", () => {
  const plan = createPlan({ workItemId: "WORK-1", mode: "multi", rationale: "parallel" });
  plan.reviewBatches.push(createReviewBatch({ id: "R1", title: "batch", risk: "medium", independentRequired: false }));
  for (const id of ["T1", "T2"]) {
    plan.tasks.push(createTask({
      id, title: id, module: "core", blockedBy: [], writeScopes: ["src/shared/**"], verification: ["test"], docsImpact: ["N/A: no docs"], reviewBatch: "R1", risk: "medium", owner: id,
    }));
    plan.reviewBatches[0].taskIds.push(id);
  }
  assert.ok(collectPlanErrors(plan, "WORK-1").some((message) => message.includes("写入范围重叠")));
  for (const task of plan.tasks) task.writeScopes = [`src/${task.id}/**`];
  for (const task of plan.tasks) task.owner = "same-owner";
  assert.ok(collectPlanErrors(plan, "WORK-1").some((message) => message.includes("不同所有者")));
});

test("scope matching is deterministic", () => {
  assert.equal(fileMatchesScope("src/core/a.mjs", "src/core/**"), true);
  assert.equal(fileMatchesScope("src/other/a.mjs", "src/core/**"), false);
  assert.equal(fileMatchesScope("README.md", "README.md"), true);
});
