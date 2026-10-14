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

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const pilot = path.join(directory, "pilot");
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("six authorized real sessions preserve the frozen comparison and make completion stages auditable", async () => {
  const baseline = await readJson(path.join(directory, "experiment-baseline.json"));
  for (const [file, digest] of Object.entries(baseline.history.files)) {
    assert.equal(hash(await readFile(path.join(root, baseline.history.directory, file))), digest, "new measurements must not rewrite the old 79-file experiment: " + file);
  }
  assert.equal(Object.keys(baseline.history.files).length, 79);
  const protocol = await readJson(path.join(pilot, "protocol.json"));
  const execution = await readJson(path.join(pilot, "execution.json"));
  const previousProtocol = await readJson(path.join(root, baseline.history.directory, "pilot/protocol.json"));
  const audited = await auditExperiment(pilot);
  assert.equal(audited.valid, true);
  assert.equal(audited.mode, "real", "simulated events cannot diagnose the actual client's finishing phase");
  assert.equal(audited.samples, 6, "timeouts and failures must stay in the same six-session denominator");
  assert.equal(protocol.source, baseline.source);
  assert.equal(protocol.source, (await sourceSnapshot(root)).digest, "evidence must remain bound to the source that was authorized");
  assert.deepEqual(protocol.driverIdentity, baseline.driverIdentity);
  assert.deepEqual(await cliIdentity(protocol.driverIdentity.entry), baseline.driverIdentity, "the client must not drift between preview and completion");
  assert.equal(protocol.suite, "core"); assert.equal(protocol.client, "codex");
  assert.equal(protocol.comparison, "paired"); assert.equal(protocol.repetitions, 1);
  assert.deepEqual(protocol.budget, { timeoutMs: 180000, maxToolCalls: 80, reasoning: "medium" });
  assert.deepEqual(protocol.groups.map(group => group.model), ["gpt-6-astra", "gpt-6-astra"], "both groups must use the same model");
  assert.deepEqual(protocol.schedule, previousProtocol.schedule);
  assert.deepEqual(protocol.tasks, previousProtocol.tasks, "public tasks and hidden judges must stay frozen across the diagnostic rerun");
  assert.equal(execution.trials.length, 6);
  assert.ok(execution.trials.every(row => row.status === "completed"), "missing sessions cannot silently disappear from the report");
  assert.ok(audited.rows.some(row => row.run.turnCompleted || row.run.toolCalls > 0), "connection-only failures cannot establish that the model experiment ran");
  const report = await createComparisonReport({ outputDirectory: pilot });
  assert.equal(report.ok, true, "completion measurements must pass the same evidence and consistency checks as delivery scores");
  assert.equal(report.mode, "real"); assert.equal(report.experiment.samples, 6);
  const timeline = [];
  for (const entry of protocol.schedule) {
    const row = audited.rows.find(value => value.taskId === entry.taskId && value.group === entry.group && value.trial === entry.trial);
    const lifecycle = row.run.timing?.lifecycle;
    assert.equal(lifecycle?.version, 1, "every attempted session must retain the new lifecycle fields, including absent observations");
    const side = entry.group === "weak-harness" ? "harness" : "baseline";
    const measured = report.pairs.find(pair => pair.taskId === entry.taskId && pair.trial === entry.trial)[side];
    for (const field of ["firstProtocolEventMs", "terminalEventMs", "processExitMs", "processCloseMs"]) {
      assert.ok(Object.hasOwn(lifecycle, field), "missing observations must be explicit null fields: " + field);
      const value = lifecycle[field];
      assert.ok(value === null || (Number.isFinite(value) && value >= 0 && value <= row.run.durationMs));
      assert.equal(measured.timing.completion[field], value, "the report must preserve the recorded anchor, not infer one from a successful score");
    }
    assert.notEqual(lifecycle.processCloseMs, null, "the driver returns at close, so an attempted result must record that observation");
    assert.equal(lifecycle.terminalEventMs !== null, row.run.turnCompleted, "a final event and a successful delivery are separate facts");
    assert.equal(measured.fullDelivery, row.success);
    const previous = await readJson(path.join(root, baseline.history.directory, "pilot", entry.directory, "result.json"));
    const previousEnds = previous.run.timing.spans.filter(span => span.complete && span.endMs !== null).map(span => span.endMs);
    const previousLastEnd = previousEnds.length ? Math.max(...previousEnds) : null;
    const phase = row.run.turnCompleted
      ? row.run.timedOut ? "预算截断且已收到完成事件" : row.run.completed ? "客户端正常完成" : "收到完成事件但客户端未成功完成"
      : row.run.timedOut ? "预算截断且未收到完成事件" : "未收到完成事件";
    timeline.push({ taskId: entry.taskId, group: entry.group, trial: entry.trial, resultFile: entry.directory + "/result.json",
      functional: row.grade.ok, sharedDelivery: measured.sharedDelivery, fullDelivery: row.success, workflow: row.workflow?.ok ?? null,
      timedOut: row.run.timedOut, toolLimit: row.run.toolLimit, completed: row.run.completed, terminalObserved: row.run.turnCompleted,
      exitCode: row.run.exitCode, durationMs: row.run.durationMs, toolCalls: row.run.toolCalls, toolActiveMs: row.run.timing.toolActiveMs,
      lifecycle: { ...lifecycle }, completion: measured.timing.completion, phase,
      previous: { durationMs: previous.run.durationMs, lastToolEndMs: previousLastEnd,
        afterLastToolMs: previousLastEnd === null ? null : previous.run.durationMs - previousLastEnd,
        fullDelivery: previous.success, timedOut: previous.run.timedOut, terminalObserved: previous.run.turnCompleted } });
  }
  await writeFile(path.join(directory, "audit.json"), JSON.stringify({ ...audited, rows: undefined }, null, 2) + "\n");
  await writeFile(path.join(directory, "comparison.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(directory, "completion-timeline.json"), JSON.stringify({ source: protocol.source, driverIdentity: protocol.driverIdentity, samples: 6, historicalFilesUnchanged: 79, timeline }, null, 2) + "\n");
});
