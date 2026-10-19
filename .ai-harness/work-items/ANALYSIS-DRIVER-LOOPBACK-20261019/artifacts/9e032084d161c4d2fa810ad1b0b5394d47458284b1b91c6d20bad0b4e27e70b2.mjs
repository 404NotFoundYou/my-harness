import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { loadContainerRuntime } from "../../../benchmarks/codex-container.mjs";
import { codexDriver } from "../../../benchmarks/codex-driver.mjs";

const mode = process.argv[2], docker = process.argv[3];
assert.ok(["success", "timeout"].includes(mode));
assert.ok(path.isAbsolute(docker), "Explicit Docker CLI path required");
const item = path.dirname(fileURLToPath(import.meta.url));
const manifest = path.join(item, "fixture-runtime.json"), reportFile = path.join(item, `driver-${mode}.json`);
const temporary = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), `ai-harness-driver-${mode}-`)));
const workspace = path.join(temporary, "workspace"), output = path.join(temporary, "output");
const digest = value => createHash("sha256").update(value).digest("hex");
const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), sourceCommit: "1826adc517954e4358cf4f9e1b24bc45507b6905",
  mode, imageKind: "derived local loopback fixture", actualModelCalls: 0, externalProviderRequests: 0, credentialsInjected: false,
  run: null, observation: null, cleanup: {}, verified: false };
let before;
function dockerResult(args) {
  const result = spawnSync(docker, args, { encoding: "utf8", shell: false, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, `Docker ${args[0]} could not start`);
  assert.equal(result.signal, null, `Docker ${args[0]} was terminated`);
  assert.equal(result.status, 0, `Docker ${args[0]} failed: ${result.stderr?.trim()}`);
  return result.stdout.trim();
}
function inventory() {
  const list = args => dockerResult(args).split(/\r?\n/).filter(Boolean).sort();
  return { images: list(["image", "ls", "--no-trunc", "--format", "{{.ID}}"]),
    containers: list(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]), volumes: list(["volume", "ls", "--quiet"]) };
}
try {
  await mkdir(workspace); await mkdir(output);
  await writeFile(path.join(workspace, "fixture-mode.txt"), mode + "\n");
  await writeFile(path.join(workspace, "TASK.md"), "Only use the local fixed responder. No real model or external service.\n");
  before = inventory();
  const selected = await loadContainerRuntime(manifest, { docker });
  report.imageId = selected.identity.imageId;
  const driver = codexDriver(selected.cli, { runtime: selected.runtime });
  const result = await driver({ root: workspace, outputDirectory: output, model: "gpt-5.4", prompt: "Return the fixed local JSON response.",
    budget: { timeoutMs: mode === "success" ? 30000 : 7000, maxToolCalls: 10, reasoning: "medium" } });
  const events = await readFile(path.join(output, "events.jsonl"));
  const final = await readFile(path.join(output, "final.json"));
  const observation = JSON.parse(await readFile(path.join(output, "provider-observation.json"), "utf8"));
  report.observation = observation;
  report.run = { mode: result.mode, client: result.client, exitCode: result.exitCode, timedOut: result.timedOut, toolLimit: result.toolLimit,
    toolCalls: result.toolCalls, turnCompleted: result.turnCompleted, protocolSuccess: result.protocolSuccess,
    completed: result.completed, final: result.final, finalOutput: result.finalOutput, unparsedLines: result.unparsedLines,
    errors: result.errors, warnings: result.warnings, error: result.error, durationMs: result.durationMs,
    eventsSha256: digest(events), finalSha256: digest(final), eventTypes: events.toString("utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).type) };
  assert.equal(observation.mode, mode); assert.ok(observation.count >= 1);
  assert.equal(observation.authorizationHeaderPresent, false);
  assert.equal(observation.model, "gpt-5.4");
  assert.equal(result.toolCalls, 0); assert.equal(result.unparsedLines, 0);
  if (mode === "success") {
    assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false); assert.equal(result.completed, true);
    assert.equal(result.turnCompleted, true); assert.equal(result.protocolSuccess, true);
    assert.deepEqual(result.final, { completed: true, summary: "fixed local response", tests: [] });
    assert.equal(result.finalOutput.status, "valid"); assert.ok(report.run.eventTypes.includes("turn.completed"));
  } else {
    assert.equal(result.timedOut, true); assert.equal(result.completed, false); assert.equal(result.toolLimit, false);
    assert.equal(result.finalOutput.status, "missing"); assert.equal(result.turnCompleted, false);
  }
  report.verified = true;
} catch (error) {
  report.error = { code: error.code ?? null, message: String(error.message).replaceAll(temporary, "<temporary>") };
  process.exitCode = 1;
} finally {
  try { const after = inventory(); report.cleanup.inventory = Object.fromEntries(Object.keys(after).map(key => [key, JSON.stringify(before?.[key]) === JSON.stringify(after[key])]));
    if (Object.values(report.cleanup.inventory).some(value => !value)) { report.verified = false; process.exitCode = 1; }
  } catch (error) { report.cleanup.inventoryError = error.message; report.verified = false; process.exitCode = 1; }
  assert.equal(path.dirname(temporary), await realpath(tmpdir()));
  assert.ok(path.basename(temporary).startsWith(`ai-harness-driver-${mode}-`));
  await rm(temporary, { recursive: true, force: true }); report.cleanup.fixturesRemoved = true;
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
