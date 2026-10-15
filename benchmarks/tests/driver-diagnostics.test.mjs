import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import fs, { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { clientDriver } from "../client-drivers.mjs";
import { auditTrial } from "../audit-trial.mjs";
import { taskManifest } from "../task-contract.mjs";
import { tasks } from "../tasks.mjs";
import { hash } from "../runner.mjs";

const final = { completed: true, summary: "中文 fixture API_TOKEN=diagnostic-secret", tests: [] };
const cases = [
  { name: "valid", text: JSON.stringify(final), status: "valid" },
  { name: "fenced", text: "```json\n" + JSON.stringify(final) + "\n```", status: "valid" },
  { name: "missing", text: null, status: "missing" },
  { name: "invalid-json", text: "{unfinished", status: "invalid-json" },
  { name: "invalid-schema", text: '{"completed":true,"summary":1,"tests":[]}', status: "invalid-schema" },
  { name: "unreadable", text: JSON.stringify(final), status: "unreadable" },
  { name: "valid-without-terminal", text: JSON.stringify(final), status: "valid" },
  { name: "timeout-after-tool", text: JSON.stringify(final), status: "valid" },
];

for (const scenario of cases) test("original final " + scenario.name + " remains diagnosable without promoting an incomplete delivery", async context => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "ai-harness-final-diagnostics-")));
  const child = new EventEmitter(); child.pid = 123456; child.exitCode = null;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let now = 1000, timer, stops = 0;
  const at = value => { now = 1000 + value; };
  const emit = (event, value) => { at(value); child.stdout.write(JSON.stringify(event) + "\n"); };
  const exit = value => { at(value); child.exitCode = scenario.name === "timeout-after-tool" ? 1 : 0; child.emit("exit", child.exitCode); };
  const close = value => { at(value); child.stdout.end(); child.stderr.end(); child.emit("close", child.exitCode); };
  const stop = () => { stops++; exit(40); close(45); return true; };
  try {
    if (scenario.text !== null) await writeFile(path.join(directory, "final.json"), scenario.text);
    if (scenario.name === "unreadable") {
      const original = fs.readFile;
      context.mock.method(fs, "readFile", async (file, ...args) => {
        if (String(file) === path.join(directory, "final.json")) throw Object.assign(new Error("private-error-canary"), { code: "EACCES" });
        return original(file, ...args);
      });
    }
    context.mock.method(Date, "now", () => now);
    context.mock.method(globalThis, "setTimeout", callback => { timer = callback; return 1; });
    context.mock.method(globalThis, "clearTimeout", () => {});
    context.mock.method(childProcess, "spawnSync", () => { stop(); return { status: 0 }; });
    context.mock.method(process, "kill", () => stop());
    context.mock.method(childProcess, "spawn", () => {
      queueMicrotask(() => {
        emit({ type: "system" }, 2);
        emit({ type: "item.started", item: { id: "tool", type: "command_execution", command: "node --test", status: "in_progress" } }, 5);
        emit({ type: "item.completed", item: { id: "tool", type: "command_execution", command: "node --test", status: "completed" } }, 7);
        emit({ type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify(final) } }, 8);
        emit({ type: "item.completed", item: { id: "progress", type: "agent_message", text: "progress is not a final response" } }, 9);
        if (!["valid-without-terminal", "timeout-after-tool"].includes(scenario.name)) emit({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }, 10);
        if (scenario.name === "timeout-after-tool") { at(30); timer(); } else { exit(12); close(16); }
      });
      return child;
    });
    syncBuiltinESMExports();
    const result = await clientDriver("codex", "synthetic.mjs")({ root: directory, model: "synthetic", prompt: "Simulated process; no model or network calls",
      budget: { timeoutMs: 1000, maxToolCalls: 80, reasoning: "medium" }, outputDirectory: directory });
    assert.deepEqual(result.finalOutput, { version: 1, status: scenario.status, exists: scenario.name === "missing" ? false : scenario.name === "unreadable" ? null : true,
      bytes: ["missing", "unreadable"].includes(scenario.name) ? null : Buffer.byteLength(scenario.text), errorCode: scenario.name === "missing" ? "ENOENT" : scenario.name === "unreadable" ? "EACCES" : null },
    "canonical null must not erase the reason that the original CLI final could not be used");
    assert.equal(result.timing.lifecycle.version, 2);
    assert.equal(result.timing.lifecycle.lastAssistantMessageMs, 9);
    assert.equal(result.timing.lifecycle.lastFinalResponseMs, 8, "later commentary cannot replace the last schema-valid response observation");
    assert.equal(result.timing.lifecycle.terminalEventMs, ["valid-without-terminal", "timeout-after-tool"].includes(scenario.name) ? null : 10);
    assert.equal(result.completed, ["valid", "fenced"].includes(scenario.name), "file/message diagnostics must not relax terminal, file or budget requirements");
    assert.equal(result.timedOut, scenario.name === "timeout-after-tool");
    assert.equal(stops, scenario.name === "timeout-after-tool" ? 1 : 0);
    assert.equal(result.timing.spans[0].endMs, 7);
    assert.doesNotMatch(JSON.stringify(result), /diagnostic-secret|private-error-canary/, "new diagnostics must contain safe scalars rather than raw file contents or exception messages");
    if (scenario.name === "valid") {
      // A real protocol shape exercises the evidence auditor with a simulated child, never a model service.
      const task = tasks[0], group = { id: "weak-baseline", model: "synthetic", harness: false };
      const protocol = { schemaVersion: 2, client: "codex", mode: "real", repetitions: 1, budget: { timeoutMs: 1000, maxToolCalls: 80, reasoning: "medium" }, tasks: [taskManifest(task)] };
      const folder = path.join(directory, task.id + "-" + group.id);
      await fs.mkdir(folder);
      for (const file of ["events.jsonl", "final.json"]) await writeFile(path.join(folder, file), await readFile(path.join(directory, file)));
      await writeFile(path.join(folder, "candidate.mjs"), task.reference);
      const row = { mode: "real", client: "codex", trial: 1, taskId: task.id, group: group.id, model: group.model,
        taskDigest: protocol.tasks[0].taskDigest, judgeDigest: protocol.tasks[0].judgeDigest, candidateDigest: hash(task.reference), budget: protocol.budget,
        run: result, scope: { ok: true }, grade: { complete: true, ok: true, exitCode: 0, cases: task.cases.map(([id]) => ({ id, pass: true })) }, success: true, falseCompletion: false };
      assert.equal((await auditTrial(directory, protocol, task, group, 1, JSON.stringify(row))).success, true);
      for (const finalOutput of [{ ...result.finalOutput, version: 2 }, { ...result.finalOutput, bytes: -1 },
        { ...result.finalOutput, status: "missing", exists: false, bytes: null, errorCode: "ENOENT" }]) {
        await assert.rejects(() => auditTrial(directory, protocol, task, group, 1, JSON.stringify({ ...row, run: { ...result, finalOutput } })),
          "the auditor must reject malformed or contradictory original-file diagnostics");
      }
      delete row.run.finalOutput;
      assert.equal((await auditTrial(directory, protocol, task, group, 1, JSON.stringify(row))).success, true, "old evidence without new diagnostics remains valid");
    }
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(path.dirname(directory), await realpath(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-final-diagnostics-"));
    await rm(directory, { recursive: true, force: true });
  }
});
