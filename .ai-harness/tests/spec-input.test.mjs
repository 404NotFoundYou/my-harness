import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { cleanup, createInstalledProject } from "./helpers.mjs";
import { beginWorkItem } from "../src/compact.mjs";
import { loadBeginSpec, diagnoseLegacyScopes } from "../src/input.mjs";
import { exists, readJson } from "../src/filesystem.mjs";
import { loadWorkItem, loadPlan } from "../src/workflow.mjs";
import { itemPolicyFiles, policyFilesFor } from "../src/policy-routing.mjs";

const definition = { schemaVersion: 1, id: "SPEC", type: "ITERATION", title: "structured input", references: ["task.json"], acceptance: ["input remains literal"], authorizationSource: "user request", risk: "low", approach: "local implementation", databaseEvidence: "no persistence", writeScopes: ["src/value.mjs", "test/value.test.mjs"], verification: [{ command: "node", args: ["--check", "src/value.mjs"] }], docsImpact: ["N/A：当前契约没有文档变化"] };

test("structured input preserves arrays, Unicode and literal comma paths without creating partial work", async () => {
  const root = await createInstalledProject();
  try {
    for (const change of [{ writeScopes: "src/a.mjs,test/b.mjs" }, { verification: [{ command:"node", args: "--version" }] }, { unexpected: true }, { authorizationSource: false }]) {
      await writeFile(path.join(root, "task.json"), JSON.stringify({ ...definition, ...change }));
      await assert.rejects(async () => beginWorkItem(root, await loadBeginSpec(root, "task.json")));
      assert.equal(await exists(path.join(root, ".ai-harness/work-items/SPEC")), false);
    }
    await assert.rejects(() => diagnoseLegacyScopes(root, ["src/a.mjs,test/b.mjs"]), { code: "AMBIGUOUS_WRITE_SCOPE" });
    await diagnoseLegacyScopes(root, ["src/a,b.mjs"]);
    await writeFile(path.join(root, "task.json"), "\uFEFF" + JSON.stringify({ ...definition, writeScopes: ["src/a.mjs,test/b.mjs"] }));
    const result = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", "begin", "--spec", "task.json", "--json"], { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const plan = await loadPlan(root, "SPEC");
    assert.deepEqual(plan.tasks[0].writeScopes, ["src/a.mjs,test/b.mjs"]);
    assert.deepEqual(plan.tasks[0].checks[0].args, ["--check", "src/value.mjs"]);
    assert.deepEqual(plan.tasks[0].docsImpact, ["N/A: 当前契约没有文档变化"]);
    assert.equal((await loadWorkItem(root, "SPEC")).policyFiles.includes(".ai-harness/policies/database.md"), false);
  } finally { await cleanup(root); }
});

test("spec and legacy definition options cannot silently override each other", async () => {
  const root = await createInstalledProject();
  try {
    await writeFile(path.join(root, "task.json"), JSON.stringify(definition));
    const result = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", "begin", "--spec", "task.json", "--id", "OTHER", "--json"], { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, "SPEC_OPTION_CONFLICT");
    assert.equal(await exists(path.join(root, ".ai-harness/work-items/SPEC")), false);
  } finally { await cleanup(root); }
});

test("database policy follows confirmed impact while legacy routing and explicit flags remain intact", async () => {
  const index = await readJson(new URL("../policies/index.json", import.meta.url));
  const item = { type: "ITERATION", flags: [], database: { impact: "none" } };
  const database = ".ai-harness/policies/database.md";
  assert.equal(itemPolicyFiles(index, item).includes(database), true);
  assert.equal(itemPolicyFiles(index, { ...item, policyRoutingVersion: 2 }).includes(database), false);
  assert.equal(itemPolicyFiles(index, { ...item, policyRoutingVersion: 2, flags: ["database"] }).includes(database), true);
  assert.equal(policyFilesFor(index, "ITERATION").includes(database), true);
  assert.equal(policyFilesFor(index, "BUGFIX", [], { databaseImpact: "required" }).includes(database), true);
});
