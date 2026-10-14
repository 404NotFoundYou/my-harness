import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { auditExperiment } from "../../../benchmarks/audit.mjs";
import { createComparisonReport } from "../../../benchmarks/report.mjs";
import { cliIdentity } from "../../../benchmarks/experiment.mjs";
import { sourceSnapshot } from "../../src/snapshot.mjs";
import { matchingChecks } from "../../src/verification.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const experiment = path.join(directory, "project-v2-comparison");
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("the bounded recheck preserves failed history and measures actual planned-stage evidence and delivery", async () => {
  const baseline = await readJson(path.join(directory, "experiment-baseline.json"));
  let unchangedFiles = 0;
  for (const history of baseline.histories) for (const [file, digest] of Object.entries(history.files)) {
    assert.equal(hash(await readFile(path.join(root, history.directory, file))), digest, "new project trials must not rewrite earlier experiments: " + history.directory + "/" + file);
    unchangedFiles++;
  }
  const ci = await readJson(path.join(directory, "ci-preflight.json"));
  assert.equal(ci.head, baseline.head);
  assert.equal(ci.runs.length, 2);
  assert.deepEqual(ci.runs.map(run => run.name).sort(), ["AI Harness", "Harness source tests"]);
  assert.ok(ci.runs.every(run => run.head_sha === baseline.head && run.status === "completed" && run.conclusion === "success"), "paid sessions must start only after both workflows pass on the intended commit");
  assert.equal(ci.jobs.length, 6);
  assert.deepEqual(ci.jobs.map(job => job.name).sort(), ["source-tests (ubuntu-latest, 20)", "source-tests (ubuntu-latest, 22)", "source-tests (ubuntu-latest, 24)", "source-tests (windows-latest, 20)", "source-tests (windows-latest, 22)", "source-tests (windows-latest, 24)"].sort());
  assert.ok(ci.jobs.every(job => job.status === "completed" && job.conclusion === "success"));
  const previousProtocol = await readJson(path.join(root, baseline.previousExperiment, "protocol.json"));
  const protocol = await readJson(path.join(experiment, "protocol.json"));
  const execution = await readJson(path.join(experiment, "execution.json"));
  const audited = await auditExperiment(experiment);
  assert.equal(audited.valid, true);
  assert.equal(audited.mode, "real", "simulated fixtures cannot establish actual model BUGFIX delivery");
  assert.equal(audited.samples, 6, "failed, timed out, or incomplete workflows must stay in the same six-session denominator");
  assert.equal(protocol.source, baseline.source);
  assert.equal(protocol.source, (await sourceSnapshot(root)).digest);
  assert.deepEqual(protocol.driverIdentity, baseline.driverIdentity);
  assert.deepEqual(await cliIdentity(protocol.driverIdentity.entry), baseline.driverIdentity, "the authorized client entry must remain frozen");
  for (const key of ["schemaVersion", "suite", "client", "comparison", "repetitions", "groups", "budget", "schedule"]) assert.deepEqual(protocol[key], baseline.plan[key]);
  assert.deepEqual(protocol.tasks, previousProtocol.tasks, "the diagnostic fix must not change the task or judge between trials");
  assert.deepEqual(protocol.budget, previousProtocol.budget);
  assert.deepEqual(protocol.groups, previousProtocol.groups);
  assert.deepEqual(protocol.schedule, previousProtocol.schedule);
  assert.deepEqual(protocol.tasks, baseline.tasks, "including holdout observations must not change public inputs or hidden judges");
  assert.equal(execution.trials.length, 6);
  assert.ok(execution.trials.every(row => row.status === "completed"), "a completed result may be a failed delivery, but missing attempts cannot be silently omitted");
  assert.ok(audited.rows.some(row => row.run.turnCompleted || row.run.toolCalls > 0), "connection-only errors cannot be described as a model effectiveness experiment");
  const report = await createComparisonReport({ outputDirectory: experiment });
  assert.equal(report.ok, true);
  assert.equal(report.mode, "real"); assert.equal(report.experiment.samples, 6); assert.equal(report.pairs.length, 3);
  const diagnostics = [];
  const completionEvents = [];
  for (const entry of protocol.schedule) {
    const row = audited.rows.find(value => value.taskId === entry.taskId && value.group === entry.group && value.trial === entry.trial);
    const side = entry.group === "weak-harness" ? "harness" : "baseline";
    const measured = report.pairs.find(pair => pair.taskId === entry.taskId && pair.trial === entry.trial)[side];
    const lifecycle = row.run.timing?.lifecycle;
    assert.equal(lifecycle?.version, 1);
    for (const field of ["firstProtocolEventMs", "terminalEventMs", "processExitMs", "processCloseMs"]) {
      assert.ok(Object.hasOwn(lifecycle, field), "unknown event times must remain explicit instead of being inferred from successful tests");
      assert.equal(measured.timing.completion[field], lifecycle[field]);
    }
    assert.notEqual(lifecycle.processCloseMs, null);
    assert.equal(lifecycle.terminalEventMs !== null, row.run.turnCompleted);
    assert.equal(measured.fullDelivery, row.success);
    const workItems = [];
    for (const id of row.workflow?.workItems || []) {
      const record = { id, archiveReadable: true, type: null, status: null, stages: [], archiveError: null };
      try {
        const folder = path.join(experiment, entry.directory, "work-items", id);
        const state = await readJson(path.join(folder, "state.json"));
        const archivedPlan = state.type === "ANALYSIS" ? null : await readJson(path.join(folder, "plan.json"));
        const evidence = (await readFile(path.join(folder, "evidence.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        record.type = state.type; record.status = state.status;
        const stages = state.verification?.stages || [];
        for (const name of ["static", "sandbox", "reproduction", "regression"]) {
          const stage = stages.find(value => value.stage === name && value.revision === state.revision);
          const command = stage?.command ? evidence.find(value => value.id === stage.command && value.kind === "command") : null;
          const matches = command && archivedPlan ? matchingChecks(archivedPlan, command.taskId, command.command.executable, command.command.args, command.command.checkTimeoutMs) : [];
          record.stages.push({ name, matches, status: stage?.status ?? null, commandId: stage?.command ?? null,
            commandStatus: command?.status ?? null, exitCode: command?.command?.exitCode ?? null, timedOut: command?.command?.timedOut ?? null });
          if (row.workflow.ok && state.type === "BUGFIX") {
            assert.equal(stage?.status, "pass", "complete BUGFIX delivery must include its required stage: " + name);
            if (["reproduction", "regression"].includes(name)) {
              assert.ok(matches.length > 0, "successful diagnostic commands cannot substitute for the declared stage checks");
              assert.equal(command?.status, "pass", "reproduction/regression claims must resolve to actual successful command evidence");
              assert.equal(command.command.exitCode, 0);
              assert.equal(command.command.timedOut, false);
            }
          }
        }
        if (row.workflow.ok) {
          assert.equal(state.status, state.type === "ANALYSIS" ? "ANSWERED" : "DONE");
          if (state.type !== "ANALYSIS") assert.equal(state.type, "BUGFIX", "an unrelated iteration cannot substitute for a completed project BUGFIX");
        }
      } catch (error) {
        if (row.workflow?.ok || !(error instanceof SyntaxError || error.code === "ENOENT")) throw error;
        record.archiveReadable = false; record.archiveError = error.code || "INVALID_JSON";
      }
      workItems.push(record);
    }
    if (row.workflow?.ok) {
      assert.equal(row.workflow.contract?.ok, true);
      assert.ok(workItems.some(value => value.type === "BUGFIX"), "functional success alone cannot satisfy the project workflow contract");
    }
    const transcript = (await readFile(path.join(experiment, entry.directory, "events.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const calls = transcript.filter(event => event.type === "item.completed" && event.item?.type === "command_execution");
    const finishes = calls.filter(event => [...String(event.item.command).matchAll(/harness\.mjs\s+finish\s+([^;\r\n]+)/g)]
      .some(match => /--id(?:\s|=)/.test(match[1]) && !/--help\b/.test(match[1])));
    const finishHelp = calls.filter(event => /harness\.mjs\s+finish\s+--help\b/.test(String(event.item.command))).map(event => event.item.id);
    const guides = calls.filter(event => String(event.item.command).includes("harness.mjs guide")).map(event => {
      let parsed = null;
      const output = String(event.item.aggregated_output || "");
      const start = output.search(/\{\s*"workItem"\s*:/);
      try { parsed = JSON.parse(start < 0 ? output : output.slice(start)); } catch {}
      return { eventId: event.item.id, exitCode: event.item.exit_code, recommendations: parsed?.verification?.commands ?? null };
    });
    completionEvents.push({ taskId: entry.taskId, group: entry.group, guides, finishHelp, finishes: finishes.map(event => ({
      eventId: event.item.id, exitCode: event.item.exit_code, span: row.run.timing.spans.find(span => span.id === event.item.id) ?? null,
      errorCodes: [...new Set([...String(event.item.aggregated_output || "").matchAll(/"code"\s*:\s*"([A-Z_]+)"/g)].map(match => match[1]))],
    })) });
    const previous = await readJson(path.join(root, baseline.previousExperiment, entry.directory, "result.json"));
    diagnostics.push({ previous: { functional: previous.grade.ok, fullDelivery: previous.success, workflow: previous.workflow?.ok ?? null, timedOut: previous.run.timedOut, durationMs: previous.run.durationMs }, taskId: entry.taskId, split: row.split, group: entry.group, trial: entry.trial, resultFile: entry.directory + "/result.json",
      functional: row.grade.ok, hiddenCases: { expected: baseline.caseCounts[entry.taskId], observed: row.grade.cases.length, passed: row.grade.cases.filter(value => value.pass).length, complete: row.grade.complete },
      scope: row.scope.ok, scopeViolations: row.scope.violations, sharedDelivery: measured.sharedDelivery, fullDelivery: row.success,
      workflow: row.workflow?.ok ?? null, workflowErrors: row.workflow?.errors ?? [], contract: row.workflow?.contract ?? null, workItems,
      completed: row.run.completed, timedOut: row.run.timedOut, toolLimit: row.run.toolLimit, terminalObserved: row.run.turnCompleted,
      durationMs: row.run.durationMs, toolCalls: row.run.toolCalls, failures: measured.failures, lifecycle: { ...lifecycle }, completion: measured.timing.completion });
  }
  await writeFile(path.join(directory, "completion-events.json"), JSON.stringify({ source: protocol.source, samples: 6, events: completionEvents }, null, 2) + "\n");
  await writeFile(path.join(directory, "audit.json"), JSON.stringify({ ...audited, rows: undefined }, null, 2) + "\n");
  await writeFile(path.join(directory, "comparison.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(directory, "workflow-diagnostics.json"), JSON.stringify({ source: protocol.source, suite: protocol.suite, samples: 6, historicalFilesUnchanged: unchangedFiles, diagnostics }, null, 2) + "\n");
});
