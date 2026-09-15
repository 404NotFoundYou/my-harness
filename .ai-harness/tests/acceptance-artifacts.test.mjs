import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { beginWorkItem, finishWorkItem } from "../src/compact.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { getWorkGuide } from "../src/guide.mjs";
import { loadBeginSpec } from "../src/input.mjs";
import { recordResult } from "../src/workflow.mjs";
import { checkProject } from "../src/checker.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

test("explicit acceptance mappings reject missing intent before creating work and retain current command identity", async () => {
  const root = await createInstalledProject();
  try {
    await writeFile(path.join(root, "value.mjs"), "export const value = 1;\n");
    const spec = { schemaVersion: 1, id: "COVER", type: "ITERATION", title: "trace acceptance", references: ["fixture"], acceptance: ["valid module", "consumer compatibility"],
      authorizationSource: "fixture", risk: "low", approach: "bounded fixture", databaseEvidence: "none", writeScopes: ["value.mjs"], docsImpact: ["N/A: unchanged"],
      verification: [{ command: "node", args: ["--check", "value.mjs"], acceptance: ["A1"] }] };
    await writeFile(path.join(root, "spec.json"), JSON.stringify(spec));
    await assert.rejects(async () => beginWorkItem(root, await loadBeginSpec(root, "spec.json")), { code: "ACCEPTANCE_MAPPING_INCOMPLETE" });
    spec.verification[0].acceptance = ["A1", "A2"];
    await writeFile(path.join(root, "spec.json"), JSON.stringify(spec));
    await beginWorkItem(root, await loadBeginSpec(root, "spec.json"));
    const command = await runRecordedCommand(root, { id: "COVER", taskId: "T1", checkId: "V1" });
    const guide = await getWorkGuide(root, "COVER");
    assert.equal(guide.coverage.mode, "explicit");
    assert.deepEqual(guide.coverage.entries.map(entry => entry.checks), [[{ taskId: "T1", checkId: "V1" }], [{ taskId: "T1", checkId: "V1" }]]);
    assert.equal(command.command.timing.executionMs, command.command.durationMs);
    assert.equal(command.command.timing.observedMs, command.command.timing.preparationMs + command.command.timing.executionMs + command.command.timing.evidencePreparationMs);
  } finally { await cleanup(root); }
});

test("archived evidence survives regeneration but tampering prevents completion", async () => {
  const root = await createInstalledProject();
  try {
    await writeFile(path.join(root, "value.mjs"), "export const value = 1;\n");
    await beginWorkItem(root, { id: "PROOF", type: "ITERATION", title: "retain proof", references: ["fixture"], acceptance: ["valid module"],
      authorizationMode: "autonomous", authorizationSource: "fixture", risk: "low", approach: "bounded", databaseEvidence: "none", writeScopes: ["value.mjs"], verification: ["node --check value.mjs"], docsImpact: ["N/A: unchanged"] });
    await runRecordedCommand(root, { id: "PROOF", taskId: "T1", checkId: "V1" });
    const artifact = ".ai-harness/work-items/PROOF/output.txt";
    await writeFile(path.join(root, artifact), "actual fixture output");
    const event = await recordResult(root, "PROOF", { kind: "verification", taskId: "T1", status: "pass", summary: "current fixture check", artifactPaths: [artifact], artifactSource: "synthetic local test fixture" });
    await writeFile(path.join(root, artifact), "later generation");
    assert.equal(await readFile(path.join(root, event.artifacts[0].path), "utf8"), "actual fixture output");
    assert.equal((await checkProject(root)).ok, true);
    await writeFile(path.join(root, event.artifacts[0].path), "modified proof");
    assert.ok((await checkProject(root)).errors.some(error => error.includes("ARTIFACT_HASH_MISMATCH")));
    await assert.rejects(() => finishWorkItem(root, "PROOF", { verification: "checked", review: "reviewed", documentation: "N/A: unchanged", acceptance: "fixture" }), { code: "ARTIFACT_HASH_MISMATCH" });
  } finally { await cleanup(root); }
});
