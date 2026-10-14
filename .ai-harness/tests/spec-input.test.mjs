import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

test("CLI judgment parameters fill only empty spec fields through literal Windows-safe arguments", async () => {
  const root = await createInstalledProject();
  try {
    const directory = path.join(root, "输入 目录");
    const relative = path.join("输入 目录", "task,定义.json");
    await mkdir(directory);
    await writeFile(path.join(root, relative), "\uFEFF" + JSON.stringify({
      ...definition,
      id: "SPEC-JUDGMENT",
      title: "结构化判断",
      risk: "",
      approach: "",
      writeScopes: ["src/值,副本.mjs"],
    }));
    const approach = "沿用现有入口，保留 PowerShell 参数数组";
    const result = spawnSync(process.execPath, [
      ".ai-harness/bin/harness.mjs", "begin", "--spec", relative,
      "--risk", "medium", "--approach", approach, "--json",
    ], { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const plan = await loadPlan(root, "SPEC-JUDGMENT");
    assert.equal(plan.rationale, approach);
    assert.equal(plan.tasks[0].risk, "medium");
    assert.deepEqual(plan.tasks[0].writeScopes, ["src/值,副本.mjs"]);
  } finally { await cleanup(root); }
});

test("spec and legacy definition options cannot silently override each other", async () => {
  const root = await createInstalledProject();
  try {
    await writeFile(path.join(root, "task.json"), JSON.stringify(definition));
    for (const [extra, code] of [
      [["--id", "OTHER"], "SPEC_OPTION_CONFLICT"],
      [["--risk", "low"], "SPEC_JUDGMENT_CONFLICT"],
      [["--approach", definition.approach], "SPEC_JUDGMENT_CONFLICT"],
    ]) {
      const result = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", "begin", "--spec", "task.json", ...extra, "--json"], { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).code, code);
      assert.equal(await exists(path.join(root, ".ai-harness/work-items/SPEC")), false);
    }
    await writeFile(path.join(root, "task.json"), JSON.stringify({ ...definition, risk: "", approach: "" }));
    const incomplete = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", "begin", "--spec", "task.json", "--risk", "low", "--json"], { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
    assert.equal(incomplete.status, 1);
    assert.equal(JSON.parse(incomplete.stderr).code, "INVALID_BEGIN_SPEC");
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


test("BUGFIX CLI judgments fill an immutable template without claiming completed verification", async () => {
  const root = await createInstalledProject();
  try {
    const relative = "缺陷,输入.json";
    const value = { ...definition, id: "SPEC-BUG", type: "BUGFIX", risk: "", approach: "", bug: { actual: "", expected: "", reproduction: "" } };
    await writeFile(path.join(root, relative), JSON.stringify(value));
    const bytes = await readFile(path.join(root, relative));
    const actual = "公共复现返回重复记录，输入顺序被改变";
    const expected = "只读输入与排他游标契约";
    const reproduction = "node --test test/public.test.mjs";
    const result = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", "begin", "--spec", relative,
      "--risk", "low", "--approach", "根据实际复现修复两个模块", "--actual", actual, "--expected", expected, "--reproduction", reproduction, "--json"],
      { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const item = await loadWorkItem(root, value.id);
    assert.deepEqual(item.bug, { actual, expected, reproduction });
    assert.equal(item.status, "IMPLEMENTING", "declared observations cannot count as successful stages or completion");
    assert.deepEqual(item.verification.stages, []);
    assert.deepEqual(await readFile(path.join(root, relative)), bytes, "the model's judgments must never rewrite the authority template");
  } finally { await cleanup(root); }
});

test("missing or conflicting BUGFIX judgments are rejected before partial work is created", async () => {
  const root = await createInstalledProject();
  const blank = { ...definition, id: "SPEC-BUG-INVALID", type: "BUGFIX", risk: "", approach: "", bug: { actual: "", expected: "", reproduction: "" } };
  const complete = ["--actual", "实际复现", "--expected", "公开契约", "--reproduction", "node --test test/public.test.mjs"];
  try {
    for (const [change, args, code] of [
      [{}, ["--actual", "实际复现"], "INVALID_BEGIN_SPEC"],
      [{}, ["--actual", " ", ...complete.slice(2)], "OPTION_REQUIRED"],
      [{ bug: [] }, complete, "INVALID_BEGIN_SPEC"],
      [{ bug: { actual: false, expected: "", reproduction: "" } }, complete, "INVALID_BEGIN_SPEC"],
      [{ bug: { actual: "固定实际描述", expected: "", reproduction: "" } }, complete, "SPEC_JUDGMENT_CONFLICT"],
      [{ bug: { actual: "", expected: "固定预期", reproduction: "" } }, complete, "SPEC_JUDGMENT_CONFLICT"],
      [{ bug: { actual: "", expected: "", reproduction: "固定复现" } }, complete, "SPEC_JUDGMENT_CONFLICT"],
      [{ type: "ITERATION" }, complete, "SPEC_OPTION_CONFLICT"],
      [{ bug: { actual: "", expected: "", reproduction: "", completed: true } }, complete, "INVALID_BEGIN_SPEC"],
      [{}, [...complete, "--writes", "outside.mjs"], "SPEC_OPTION_CONFLICT"],
    ]) {
      await writeFile(path.join(root, "bug.json"), JSON.stringify({ ...blank, ...change }));
      const before = await readFile(path.join(root, "bug.json"));
      const result = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", "begin", "--spec", "bug.json", "--risk", "low", "--approach", "按实际复现修复", ...args, "--json"],
        { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
      assert.equal(result.status, 1, "incomplete observations and authority conflicts must never create a work item");
      assert.equal(JSON.parse(result.stderr).code, code, result.stderr);
      assert.equal(await exists(path.join(root, ".ai-harness/work-items", blank.id)), false);
      assert.deepEqual(await readFile(path.join(root, "bug.json")), before);
    }
    await writeFile(path.join(root, "complete.json"), JSON.stringify({ ...definition, id: "SPEC-BUG-COMPLETE", type: "BUGFIX",
      bug: { actual: "原实际", expected: "公开预期", reproduction: "公共复现" } }));
    assert.equal((await beginWorkItem(root, await loadBeginSpec(root, "complete.json"))).status, "IMPLEMENTING", "old complete BUGFIX specs must retain their behavior");
  } finally { await cleanup(root); }
});
