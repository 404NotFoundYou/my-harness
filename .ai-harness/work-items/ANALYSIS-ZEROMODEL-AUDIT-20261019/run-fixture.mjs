import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditExperiment } from "../../../benchmarks/audit.mjs";
import { codexDriver } from "../../../benchmarks/codex-driver.mjs";
import { loadContainerRuntime } from "../../../benchmarks/codex-container.mjs";
import { experimentPlan, runExperiment } from "../../../benchmarks/experiment.mjs";

const item = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(item, "../../..");
const outputDirectory = path.join(item, "experiment-retry");
const manifest = path.join(item, "../ANALYSIS-DRIVER-LOOPBACK-20261019/fixture-runtime.json");
const scratch = path.join(item, "scratch");
await mkdir(scratch);
process.env.TEMP = scratch;
process.env.TMP = scratch;
assert.equal(await realpath(tmpdir()), await realpath(scratch));

function inventory() {
  const list = args => execFileSync("docker", args, { encoding: "utf8", timeout: 30000 })
    .trim().split(/\r?\n/).filter(Boolean).sort();
  return { containers: list(["container", "ls", "--all", "--quiet"]), volumes: list(["volume", "ls", "--quiet"]) };
}

const before = inventory();
try {
  const selected = await loadContainerRuntime(manifest);
  const actualDriver = codexDriver(selected.cli, { runtime: selected.runtime });
  const observations = [];
  const plan = experimentPlan({ suite: "project-v2", comparison: "paired", repetitions: 1,
    weak: "gpt-5.4", timeoutMs: 30000, maxToolCalls: 10 });
  const summary = await runExperiment({ plan, sourceRoot, outputDirectory,
    driverIdentity: selected.identity, readDriverIdentity: selected.readIdentity,
    driver: async input => {
      const marker = path.join(input.root, "fixture-mode.txt");
      await writeFile(marker, "success\n", { flag: "wx" });
      try {
        const result = await actualDriver(input);
        const observation = JSON.parse(await readFile(path.join(input.outputDirectory, "provider-observation.json"), "utf8"));
        observations.push(observation);
        return result;
      } finally {
        await rm(marker);
      }
    },
    onProgress: event => console.log(JSON.stringify(event)),
  });
  const audit = await auditExperiment(outputDirectory);
  assert.equal(summary.complete, true);
  assert.equal(audit.valid, true);
  assert.equal(audit.samples, 6);
  assert.equal(audit.mode, "real");
  assert.equal(observations.length, 6);
  assert.ok(observations.every(row => row.mode === "success" && row.count >= 1
    && row.authorizationHeaderPresent === false && row.model === "gpt-5.4"));
  assert.ok(audit.rows.every(row => row.run.completed && row.run.protocolSuccess && row.scope.ok));
  assert.ok(audit.rows.every(row => !row.success && !row.grade.ok));
  assert.deepEqual(inventory(), before, "Docker containers or volumes changed after the experiment");
  assert.deepEqual(await readdir(scratch), [], "Temporary participant directories were not cleaned up");
  const report = { fixtureOnly: true, actualModelCalls: 0, imageId: selected.identity.imageId,
    auditValid: audit.valid, samples: audit.samples, mode: audit.mode,
    functionalPassed: audit.rows.filter(row => row.grade.ok).length,
    fullDelivery: audit.rows.filter(row => row.success).length,
    localResponseCounts: observations.map(row => row.count),
    authorizationHeadersPresent: observations.some(row => row.authorizationHeaderPresent),
    dockerInventoryUnchanged: true, scratchEmpty: true };
  await writeFile(path.join(item, "audit-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report));
} finally {
  assert.deepEqual(inventory(), before, "Docker containers or volumes changed after the experiment");
}
