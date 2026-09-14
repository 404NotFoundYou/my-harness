// Read-only product assessment. All counterexample mutations occur in temporary test repositories.
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInstalledProject, cleanup, git } from "../../tests/helpers.mjs";
import { beginWorkItem, finishWorkItem } from "../../src/compact.mjs";
import { checkProject } from "../../src/checker.mjs";
import { getWorkGuide } from "../../src/guide.mjs";
import { runRecordedCommand } from "../../src/evidence.mjs";
import { classifyCommand } from "../../src/policy.mjs";
import { addTask, recordResult, transitionWorkItem, updateTaskStatus } from "../../src/workflow.mjs";

const results = [];
const verdict = (commandIds) => ({ commandIds, verification: "controlled counterexample fixture", review: "controlled fixture verdict", documentation: "N/A: fixture only", acceptance: "controlled fixture verdict" });
const options = (id, writes = ["sample.mjs"], verification = ["node --check sample.mjs"]) => ({
  id, type: "ITERATION", title: "controlled assessment fixture", references: ["assessment fixture"],
  acceptance: ["sample passes its check"], authorizationMode: "autonomous", authorizationSource: "temporary fixture only",
  risk: "medium", approach: "inspect verification behavior", databaseEvidence: "no database", writeScopes: writes,
  verification, docsImpact: ["N/A: fixture only"],
});
const run = (root, id, args = ["--version"], taskId = "T1") => runRecordedCommand(root, { id, taskId, command: process.execPath, args });
const actualCheck = (root, args) => spawnSync(process.execPath, args, { cwd: root, shell: false, windowsHide: true, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
async function errorCode(action) {
  try { await action(); return null; } catch (error) { return error.code || error.message; }
}
async function completeTask(root, id, command) {
  await recordResult(root, id, { taskId: "T1", kind: "verification", status: "pass", summary: `fixture command ${command.id}` });
  await updateTaskStatus(root, id, "T1", "IMPLEMENTED");
  await updateTaskStatus(root, id, "T1", "IN_REVIEW");
  await recordResult(root, id, { taskId: "T1", kind: "review", status: "pass", summary: "fixture review" });
  await updateTaskStatus(root, id, "T1", "COMPLETED");
  await transitionWorkItem(root, id, "VERIFYING");
  await recordResult(root, id, { kind: "verification", status: "pass", summary: "fixture verification" });
  await recordResult(root, id, { kind: "documentation", status: "not-applicable", summary: "fixture only" });
}
async function probe(name, action) {
  const root = await createInstalledProject();
  try {
    const detail = await action(root);
    const result = { name, ...detail };
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = { name, unexpectedError: error.code || error.message };
    results.push(result);
    console.log(JSON.stringify(result));
    process.exitCode = 1;
  } finally {
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative) && path.basename(root).startsWith("ai-harness-test-"));
    await cleanup(root);
  }
}

await probe("stale_code_evidence", async (root) => {
  const id = "STALE";
  await beginWorkItem(root, options(id));
  await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
  const command = await run(root, id, ["--check", "sample.mjs"]);
  await writeFile(path.join(root, "sample.mjs"), "const = ;\n");
  const actual = actualCheck(root, ["--check", "sample.mjs"]);
  const done = await finishWorkItem(root, id, verdict([command.id]));
  const checked = await checkProject(root, { ci: true });
  return { originalCommand: command.status, actualCurrentExitCode: actual.status, finalStatus: done.status, ciOk: checked.ok, ciErrors: checked.errors };
});

await probe("unrelated_command_satisfies_verification", async (root) => {
  const id = "UNRELATED";
  await beginWorkItem(root, options(id, ["case.test.mjs"], ["node --test case.test.mjs"]));
  await writeFile(path.join(root, "case.test.mjs"), 'throw new Error("intentional failing acceptance fixture");\n');
  const command = await run(root, id);
  const guide = await getWorkGuide(root, id);
  const actual = actualCheck(root, ["--test", "case.test.mjs"]);
  const done = await finishWorkItem(root, id, verdict([command.id]));
  const checked = await checkProject(root, { ci: true });
  return { planned: "node --test case.test.mjs", executed: "node --version", actualAcceptanceExitCode: actual.status, guideNext: guide.next.code, finalStatus: done.status, ciOk: checked.ok };
});

await probe("late_failure_does_not_invalidate_pass", async (root) => {
  const id = "LATE-FAILURE";
  await beginWorkItem(root, options(id));
  await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
  const command = await run(root, id, ["--check", "sample.mjs"]);
  await completeTask(root, id, command);
  await writeFile(path.join(root, "sample.mjs"), "const = ;\n");
  const failed = await run(root, id, ["--check", "sample.mjs"], null);
  const guide = await getWorkGuide(root, id);
  await transitionWorkItem(root, id, "CODE_REVIEW");
  await recordResult(root, id, { kind: "review", status: "pass", summary: "controlled false-positive fixture" });
  await transitionWorkItem(root, id, "READY_FOR_ACCEPTANCE");
  await recordResult(root, id, { kind: "acceptance", status: "pass", summary: "controlled false-positive fixture" });
  const done = await transitionWorkItem(root, id, "DONE");
  return { latestCommand: failed.status, guideNext: guide.next.code, guideTarget: guide.next.workTarget, finalStatus: done.status, ciOk: (await checkProject(root, { ci: true })).ok };
});

await probe("deleted_outside_file_not_detected", async (root) => {
  await writeFile(path.join(root, "unrelated.txt"), "preserve this unrelated file\n");
  git(root, ["add", "unrelated.txt"]);
  git(root, ["commit", "-m", "fixture baseline"]);
  const id = "DELETION";
  await beginWorkItem(root, options(id));
  await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
  await rm(path.join(root, "unrelated.txt"));
  const command = await run(root, id, ["--check", "sample.mjs"]);
  await finishWorkItem(root, id, verdict([command.id]));
  const checked = await checkProject(root, { ci: true });
  return { gitDeletion: git(root, ["status", "--porcelain"]).stdout.split(/\r?\n/).find((line) => line.includes("unrelated.txt")), deletionInCheckedFiles: checked.details.changedFiles.includes("unrelated.txt"), ciOk: checked.ok, ciErrors: checked.errors };
});

await probe("completed_work_item_scope_remains_active", async (root) => {
  await beginWorkItem(root, options("OLD", ["old.mjs"], ["node --check old.mjs"]));
  await writeFile(path.join(root, "old.mjs"), "const old = 1;\n");
  const first = await run(root, "OLD", ["--check", "old.mjs"]);
  await finishWorkItem(root, "OLD", verdict([first.id]));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "complete old fixture"]);
  await beginWorkItem(root, options("NEW", ["new.mjs"], ["node --check new.mjs"]));
  await writeFile(path.join(root, "new.mjs"), "const current = 1;\n");
  await writeFile(path.join(root, "old.mjs"), "const changedOutsideCurrentScope = 2;\n");
  const second = await run(root, "NEW", ["--check", "new.mjs"]);
  await finishWorkItem(root, "NEW", verdict([second.id]));
  const checked = await checkProject(root, { ci: true });
  return { currentScope: ["new.mjs"], oldFileChanged: checked.details.changedFiles.includes("old.mjs"), oldScopeStillAllowed: checked.details.allowedScopes.includes("old.mjs"), ciOk: checked.ok };
});

await probe("final_review_has_no_rework_route", async (root) => {
  const id = "REWORK";
  await beginWorkItem(root, options(id));
  await writeFile(path.join(root, "sample.mjs"), "const valid = 1;\n");
  const command = await run(root, id, ["--check", "sample.mjs"]);
  await completeTask(root, id, command);
  await transitionWorkItem(root, id, "CODE_REVIEW");
  await recordResult(root, id, { kind: "review", status: "fail", summary: "review requires changes and revalidation" });
  return {
    returnToImplementation: await errorCode(() => transitionWorkItem(root, id, "IMPLEMENTING")),
    revalidate: await errorCode(() => run(root, id, ["--check", "sample.mjs"], null)),
    addTask: await errorCode(() => addTask(root, id, { id: "T2", title: "extra required work" })),
    guideNext: (await getWorkGuide(root, id)).next.code,
  };
});

await probe("windows_package_manager_execution", async (root) => {
  const id = "WINDOWS";
  await beginWorkItem(root, options(id, ["sample.mjs"], ["npm --version"]));
  const observed = [];
  for (const command of ["npm", "npm.cmd"]) {
    const event = await runRecordedCommand(root, { id, taskId: "T1", command, args: ["--version"] });
    observed.push({ command, policy: event.command.policy.decision, status: event.status, exitCode: event.command.exitCode, spawnError: event.command.spawnError });
  }
  return { platform: process.platform, observed };
});

const policy = {
  name: "version_token_changes_eval_classification",
  withoutVersion: classifyCommand("node", ["--eval", "console.log(1)"]).decision,
  withPositionalVersion: classifyCommand("node", ["--eval", "console.log(1)", "version"]).decision,
  payloadExecuted: false,
};
results.push(policy);
console.log(JSON.stringify(policy));
await writeFile(fileURLToPath(new URL("./probe-results.json", import.meta.url)), JSON.stringify(results, null, 2) + "\n");
