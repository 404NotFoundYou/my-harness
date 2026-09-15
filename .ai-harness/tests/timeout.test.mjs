import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { compileChecks, parseCommand } from "../src/commands.mjs";
import { beginWorkItem, finishWorkItem } from "../src/compact.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { exists } from "../src/filesystem.mjs";
import { getWorkGuide } from "../src/guide.mjs";
import { loadBeginSpec } from "../src/input.mjs";
import { assertCommandEvidence, planDigest, verificationReport } from "../src/verification.mjs";
import { approvePlan, editTask, loadPlan, loadWorkItem, reopenWorkItem, transitionWorkItem, updateTaskStatus } from "../src/workflow.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

const id = "BUDGET";
const runner = ".ai-harness/tests/run.mjs";
const command = (timeoutMs, args = ["--version"]) => ({ command: "node", args, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
const options = verification => ({
  id, type: "ITERATION", title: "planned verification budget", references: ["isolated regression"],
  acceptance: ["checks use only their approved budget and matching evidence"],
  authorizationMode: "autonomous", authorizationSource: "test fixture", risk: "medium",
  approach: "exercise the existing runner", databaseEvidence: "no database",
  writeScopes: [runner, ".ai-harness/config.json"], verification: verification.map(value => JSON.stringify(value)),
  docsImpact: ["N/A: isolated fixture"],
});
const verdict = { verification: "declared checks passed", review: "fixture assertions checked", documentation: "N/A: isolated fixture", acceptance: "budget and evidence contract verified" };
const run = (root, checkId) => runRecordedCommand(root, { id, taskId: "T1", checkId });
const direct = (root, args) => runRecordedCommand(root, { id, taskId: "T1", command: "node", args });
async function report(root, events) {
  return verificationReport(root, await loadWorkItem(root, id), await loadPlan(root, id), events ? { events } : {});
}

async function fixture(checks, { globalTimeout = 5000, body = 'process.stdout.write("checked");' } = {}) {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, options(checks));
    await writeFile(path.join(root, runner), body);
    const configPath = path.join(root, ".ai-harness/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, JSON.stringify({ ...config, commandTimeoutMs: globalTimeout }));
    return root;
  } catch (error) { await cleanup(root); throw error; }
}

function cli(root, args) {
  const result = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", ...args, "--json"], {
    cwd: root, encoding: "utf8", shell: false, windowsHide: true, timeout: 30000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("check budgets are bounded without adding fields to historical definitions", () => {
  for (const timeoutMs of [1, 5000, 1800000]) {
    assert.deepEqual(parseCommand(command(timeoutMs)), command(timeoutMs));
    assert.equal(compileChecks([JSON.stringify(command(timeoutMs))])[0].timeoutMs, timeoutMs);
  }
  for (const timeoutMs of [null, 0, -1, 1.5, "5000", 1800001, Infinity, NaN]) {
    assert.throws(() => parseCommand(command(timeoutMs)), { code: "INVALID_CHECK_TIMEOUT" });
  }
  assert.deepEqual(compileChecks(["node --version"]), [{ id: "V1", command: "node", args: ["--version"] }]);
  assert.deepEqual(parseCommand({ ...command(), timeoutMs: undefined }), command());
});

test("spec, run-all, guide and repeated finish preserve distinct approved budgets", async () => {
  const root = await createInstalledProject();
  try {
    const checks = [command(5000), command(8000)];
    const spec = { schemaVersion: 1, ...options(checks), verification: checks };
    for (const timeoutMs of [null, 0, "5000", 1800001]) {
      await writeFile(path.join(root, "task.json"), JSON.stringify({ ...spec, verification: [command(timeoutMs)] }));
      await assert.rejects(() => loadBeginSpec(root, "task.json"), { code: "INVALID_CHECK_TIMEOUT" });
      assert.equal(await exists(path.join(root, ".ai-harness/work-items/BUDGET")), false);
    }
    await writeFile(path.join(root, "task.json"), JSON.stringify(spec));
    cli(root, ["begin", "--spec", "task.json"]);
    assert.deepEqual((await loadPlan(root, id)).tasks[0].checks.map(check => check.timeoutMs), [5000, 8000]);
    const result = cli(root, ["run", "--id", id, "--task", "T1", "--all"]);
    assert.equal(result.status, "pass");
    assert.deepEqual(result.commands.map(entry => entry.timeoutMs), [5000, 8000]);
    const guide = await getWorkGuide(root, id, { taskId: "T1" });
    assert.equal(guide.evidence.commands.length, 2);
    assert.deepEqual(guide.evidence.commands.map(entry => entry.checkTimeoutMs).sort((a, b) => a - b), [5000, 8000]);
    const completed = await finishWorkItem(root, id, verdict);
    assert.equal(completed.status, "DONE");
    assert.deepEqual(new Set(completed.verificationCommands), new Set(result.commands.map(entry => entry.id)));
    const again = await finishWorkItem(root, id);
    assert.equal(again.alreadyDone, true);
    assert.deepEqual(new Set(again.verificationCommands), new Set(completed.verificationCommands));
  } finally { await cleanup(root); }
});

test("a long planned check can finish while a direct command retains the short global limit", async () => {
  const root = await fixture([command(5000, [runner])], { globalTimeout: 100, body: 'setTimeout(() => process.stdout.write("finished"), 300);' });
  try {
    const planned = await run(root, "V1");
    assert.equal(planned.status, "pass");
    assert.equal(planned.command.stdout.text, "finished");
    assert.equal(planned.command.timeoutMs, 5000);
    assert.equal(planned.command.checkTimeoutMs, 5000);
    assert.deepEqual(planned.command.checkIds, [{ taskId: "T1", checkId: "V1" }]);
    const diagnostic = await direct(root, [runner]);
    assert.equal(diagnostic.status, "fail");
    assert.equal(diagnostic.command.failureReason, "timeout");
    assert.equal(diagnostic.command.timeoutMs, 100);
    assert.equal(diagnostic.command.checkTimeoutMs, undefined);
    assert.deepEqual(diagnostic.command.checkIds, []);
    const rerun = await run(root, "V1");
    assert.equal(rerun.status, "pass");
    const current = await report(root);
    assert.deepEqual(current.missing, []);
    assert.deepEqual(current.failed.map(entry => entry.id), [diagnostic.id]);
    const guide = await getWorkGuide(root, id, { taskId: "T1" });
    assert.equal(guide.next.code, "resolve-command-failure");
    assert.ok(guide.next.needs.some(value => /reopen.*replan/.test(value)));
    assert.equal(guide.evidence.commands.length, 2);
    await assert.rejects(() => finishWorkItem(root, id, verdict), { code: "VERIFICATION_NOT_CURRENT" });
  } finally { await cleanup(root); }
});

test("a longer budget's success cannot hide a shorter budget's failure", async () => {
  const root = await fixture([command(100, [runner]), command(5000, [runner])], { body: 'setTimeout(() => process.stdout.write("finished"), 300);' });
  try {
    const short = await run(root, "V1");
    assert.equal(short.status, "fail");
    assert.equal(short.command.timedOut, true);
    assert.equal(short.command.timeoutMs, 100);
    const long = await run(root, "V2");
    assert.equal(long.status, "pass");
    assert.deepEqual(long.command.checkIds, [{ taskId: "T1", checkId: "V2" }]);
    const current = await report(root);
    assert.equal(current.ok, false);
    assert.deepEqual(current.missing.map(check => check.id), ["V1"]);
    assert.deepEqual(current.failed.map(entry => entry.id), [short.id]);
    const guide = await getWorkGuide(root, id, { taskId: "T1" });
    assert.ok(guide.next.command.args.includes("V1"));
    assert.equal(guide.evidence.commands.length, 2);
  } finally { await cleanup(root); }
});

test("changing a budget requires new evidence and replan retains the prior revision", async () => {
  const root = await fixture([command(5000)]);
  try {
    const first = await run(root, "V1");
    const item = await loadWorkItem(root, id);
    const plan = await loadPlan(root, id);
    const changed = structuredClone(plan);
    changed.tasks[0].checks[0].timeoutMs = 8000;
    assert.notEqual(planDigest(item, changed), planDigest(item, plan));
    assert.equal((await verificationReport(root, item, changed)).ok, false);
    await reopenWorkItem(root, id, { reason: "approve a different check budget", replan: true });
    await editTask(root, id, "T1", { verification: [JSON.stringify(command(8000))] });
    await approvePlan(root, id, "fixture authorization");
    await transitionWorkItem(root, id, "PLANNED");
    await transitionWorkItem(root, id, "IMPLEMENTING");
    await updateTaskStatus(root, id, "T1", "IN_PROGRESS");
    assert.equal((await loadPlan(root, id)).tasks[0].checks[0].timeoutMs, 8000);
    const currentItem = await loadWorkItem(root, id);
    const currentPlan = await loadPlan(root, id);
    await assert.rejects(() => assertCommandEvidence(root, currentItem, currentPlan, first.id), { code: "COMMAND_EVIDENCE_INVALID" });
    const second = await run(root, "V1");
    assert.equal(second.revision, 2);
    assert.equal(second.command.timeoutMs, 8000);
    assert.equal((await finishWorkItem(root, id, { ...verdict, commandIds: [second.id] })).status, "DONE");
    const archived = JSON.parse(await readFile(path.join(root, ".ai-harness/work-items/BUDGET/revisions/1-plan.json"), "utf8"));
    assert.equal(archived.tasks[0].checks[0].timeoutMs, 5000);
  } finally { await cleanup(root); }
});

test("explicit budget evidence must agree with the actual timeout while historical evidence stays valid", async () => {
  const root = await fixture([command(), command(5000)]);
  try {
    const legacy = await run(root, "V1");
    const planned = await run(root, "V2");
    assert.deepEqual(legacy.command.checkIds, [{ taskId: "T1", checkId: "V1" }]);
    for (const change of [{ timeoutMs: 8000 }, { timeoutMs: undefined }, { checkTimeoutMs: 0 }, { checkTimeoutMs: null }, { checkTimeoutMs: "5000" }]) {
      const invalid = { ...planned, command: { ...planned.command, ...change } };
      await assert.rejects(() => report(root, [legacy, invalid]), { code: "INVALID_COMMAND_TIMEOUT_EVIDENCE" });
    }
    const old = structuredClone(legacy);
    delete old.command.timeoutMs;
    assert.equal((await report(root, [old, planned])).ok, true);
    const unclaimed = structuredClone(planned);
    delete unclaimed.command.checkTimeoutMs;
    assert.deepEqual((await report(root, [old, unclaimed])).missing.map(check => check.id), ["V2"]);
  } finally { await cleanup(root); }
});

test("a stored legacy plan with an invalid budget is rejected before starting its command", async () => {
  const root = await fixture([command(undefined, [runner])], { body: 'import { writeFileSync } from "node:fs"; writeFileSync("started.txt", "unexpected");' });
  try {
    // Deliberately corrupt an isolated legacy plan to exercise the execution boundary.
    const planPath = path.join(root, ".ai-harness/work-items/BUDGET/plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    delete plan.tasks[0].checks;
    plan.tasks[0].verification = [JSON.stringify(command(0, [runner]))];
    await writeFile(planPath, JSON.stringify(plan));
    await assert.rejects(() => run(root, "V1"), { code: "INVALID_CHECK_TIMEOUT" });
    assert.equal(await exists(path.join(root, "started.txt")), false);
  } finally { await cleanup(root); }
});
