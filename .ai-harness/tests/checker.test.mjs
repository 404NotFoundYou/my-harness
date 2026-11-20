import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkProject, doctorProject } from "../src/checker.mjs";
import { installRuntime, initializeProject } from "../src/installer.mjs";
import {
  addAnalysisConclusion,
  completeBaseline,
  createWorkItemState,
  recordResult,
  transitionWorkItem,
  workItemPaths,
} from "../src/workflow.mjs";
import { cleanup, createInstalledProject, git, sourceRoot, useLegacyReceipt } from "./helpers.mjs";

test("doctor reports a concise Git summary without baseline fingerprints", async () => {
  const root = await createInstalledProject();
  try {
    const result = await doctorProject(root);
    assert.equal(result.ok, true);
    assert.equal(result.details.repository.isGit, true);
    assert.equal("fingerprints" in result.details.repository, false);
  } finally {
    await cleanup(root);
  }
});

test("doctor bounds dirty path output while retaining exact totals", async () => {
  const root = await createInstalledProject();
  try {
    const control = path.join(root, ".ai-harness/work-items/NOISE");
    await mkdir(control, { recursive: true });
    for (let index = 0; index < 60; index += 1) await writeFile(path.join(control, `${String(index).padStart(2, "0")}.txt`), "control\n");
    await writeFile(path.join(root, "product-change.txt"), "product\n");
    const result = await doctorProject(root);
    assert.equal(result.ok, true);
    assert.equal(result.details.repository.dirty, true);
    assert.equal(result.details.repository.changedFileCount, 61);
    assert.equal(result.details.repository.changedFiles.length, 50);
    assert.equal(result.details.repository.changedFilesOmitted, 11);
    assert.equal(result.details.repository.productChangedFileCount, 1);
    assert.equal(result.details.repository.controlChangedFileCount, 60);
    assert.equal(result.details.repository.changedFiles[0], "product-change.txt");
    assert.equal("fingerprints" in result.details.repository, false);
  } finally {
    await cleanup(root);
  }
});

for (const legacy of [false, true]) test(legacy ? "legacy receipts cannot claim an initial installation delivery" :
  "first adoption owns only the committed installation, including the managed part of existing rules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-harness-first-install-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "Harness Test"]);
    git(root, ["config", "user.email", "harness-test@example.invalid"]);
    await writeFile(path.join(root, "AGENTS.md"), "# Project rules\n");
    await writeFile(path.join(root, "CLAUDE.md"), "@AGENTS.md\n");
    await writeFile(path.join(root, "product.txt"), "existing feature\n");
    const commit = (message, ...flags) => { git(root, ["add", "."]); git(root, ["commit", ...flags, "-m", message]); };
    commit("existing application");
    const base = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    await installRuntime(sourceRoot, root);
    if (legacy) await useLegacyReceipt(root);
    const project = await initializeProject(root, { mode: "existing", docsMode: "existing" });
    commit("install and initialize runtime");
    const clean = await checkProject(root, { ci: true, base });
    if (legacy) {
      assert.equal(project.initialInstall, undefined);
      assert.equal(clean.ok, false);
      assert.ok(clean.details.changedFiles.includes(".ai-harness/manifest.json"));
      return;
    }
    assert.equal(clean.ok, true, JSON.stringify(clean.errors));
    await writeFile(path.join(root, "product.txt"), "unrelated product change\n");
    const installedRules = await readFile(path.join(root, "AGENTS.md"), "utf8");
    await writeFile(path.join(root, "AGENTS.md"), installedRules.replace("# Project rules", "# Changed project rules"));
    await writeFile(path.join(root, ".ai-harness/project.json"), JSON.stringify({ ...project, extra: "unrelated metadata" }));
    commit("install with unrelated edits", "--amend");
    const mixed = await checkProject(root, { ci: true, base });
    assert.equal(mixed.ok, false);
    assert.deepEqual(mixed.details.changedFiles, [".ai-harness/project.json", "AGENTS.md", "product.txt"]);
    await writeFile(path.join(root, ".ai-harness/src/evidence.mjs"), "// not from installer\n");
    commit("change installed file");
    assert.ok((await checkProject(root, { ci: true, base })).details.changedFiles.includes(".ai-harness/src/evidence.mjs"));
  } finally { await cleanup(root); }
});

test("doctor accepts managed AGENTS with byte-preserved compatible adapters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-harness-doctor-compatible-"));
  try {
    await writeFile(path.join(root, "AGENTS.md"), "# Existing product rules\n", "utf8");
    await writeFile(path.join(root, "CLAUDE.md"), "# Claude rules\n\n@AGENTS.md\n", "utf8");
    await writeFile(path.join(root, "GEMINI.md"), "# Gemini rules\n\n@./AGENTS.md\n", "utf8");
    await installRuntime(sourceRoot, root);
    git(root, ["init"]);
    await initializeProject(root, { mode: "existing", docsMode: "existing" });

    const result = await doctorProject(root);
    assert.equal(result.ok, true);
    assert.equal(result.details.instructionFiles["AGENTS.md"].mode, "managed");
    assert.equal(result.details.instructionFiles["CLAUDE.md"].mode, "compatible-existing");
    assert.equal(result.details.instructionFiles["GEMINI.md"].mode, "compatible-existing");
  } finally {
    await cleanup(root);
  }
});

test("doctor fails when managed instruction content is modified", async () => {
  const root = await createInstalledProject();
  try {
    const agentsPath = path.join(root, "AGENTS.md");
    const original = await readFile(agentsPath, "utf8");
    await writeFile(agentsPath, original.replace("## 开发门禁", "## 被修改的开发门禁"), "utf8");

    const result = await doctorProject(root);
    assert.equal(result.ok, false);
    assert.equal(result.details.instructionFiles["AGENTS.md"].hashValid, false);
    assert.ok(result.errors.some((message) => message.includes("AGENTS.md 的 Harness 托管块哈希无效")));
  } finally {
    await cleanup(root);
  }
});

test("CI rejects every non-terminal work item including BLOCKED", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "BLOCKED-1",
      type: "ITERATION",
      title: "blocked work",
      references: ["approved PRD"],
      acceptance: ["work completes"],
      nonGoals: [],
      authorizationMode: "autonomous",
      authorizationSource: "test authorization",
    });
    await transitionWorkItem(root, "BLOCKED-1", "BLOCKED", "required external service unavailable");
    const result = await checkProject(root, { ci: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.includes("BLOCKED-1:BLOCKED")));
  } finally {
    await cleanup(root);
  }
});

test("check rejects result references that do not exist in evidence JSONL", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "ANALYSIS-TAMPER",
      type: "ANALYSIS",
      title: "evidence integrity",
      references: ["question"],
      acceptance: ["answer is evidence-backed"],
      nonGoals: [],
      authorizationMode: "approval-required",
      authorizationSource: "read-only request",
    });
    await transitionWorkItem(root, "ANALYSIS-TAMPER", "BASELINING");
    await completeBaseline(root, "ANALYSIS-TAMPER", { evidence: ["current checkout"] });
    await transitionWorkItem(root, "ANALYSIS-TAMPER", "ANALYZING");
    await addAnalysisConclusion(root, "ANALYSIS-TAMPER", {
      status: "PROVEN",
      text: "runtime exists",
      evidence: [".ai-harness/manifest.json"],
    });
    await recordResult(root, "ANALYSIS-TAMPER", {
      kind: "analysis",
      status: "pass",
      summary: "answer separates facts from unknowns",
    });
    await transitionWorkItem(root, "ANALYSIS-TAMPER", "ANSWERED");

    const paths = await workItemPaths(root, "ANALYSIS-TAMPER");
    const item = JSON.parse(await readFile(paths.state, "utf8"));
    item.analysis.evidence.push("forged-evidence-id");
    await writeFile(paths.state, `${JSON.stringify(item, null, 2)}\n`, "utf8");

    const result = await checkProject(root);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((message) => message.includes("引用不存在的证据：forged-evidence-id")));
  } finally {
    await cleanup(root);
  }
});

test("check rejects policy files that do not match type and flags", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "POLICY-TAMPER",
      type: "ANALYSIS",
      title: "policy integrity",
      references: ["question"],
      acceptance: ["policy route is deterministic"],
      nonGoals: [],
      authorizationMode: "approval-required",
      authorizationSource: "read-only request",
    });
    const paths = await workItemPaths(root, "POLICY-TAMPER");
    const item = JSON.parse(await readFile(paths.state, "utf8"));
    item.policyFiles = [".ai-harness/policies/core.md"];
    await writeFile(paths.state, `${JSON.stringify(item, null, 2)}\n`, "utf8");
    const result = await checkProject(root);
    assert.ok(result.errors.some((message) => message.includes("确定性路由不一致")));
  } finally {
    await cleanup(root);
  }
});


test("CI checks the selected commit range even when the checkout is clean", async () => {
  const root = await createInstalledProject();
  try {
    const base = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(path.join(root, "unexpected.mjs"), "export const changed = true;\n");
    git(root, ["add", "unexpected.mjs"]);
    git(root, ["commit", "-m", "untracked-by-work-item change"]);
    const result = await checkProject(root, { ci: true, base });
    assert.equal(result.ok, false);
    assert.deepEqual(result.details.changedFiles, ["unexpected.mjs"]);
  } finally { await cleanup(root); }
});

test("CI accepts a declared existing-doc edit and binds it to the committed content", async () => {
  const root = await createInstalledProject();
  try {
    const file = path.join(root, "README.md");
    await writeFile(file, "# Orginal wording\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "docs baseline"]);
    const base = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    await writeFile(file, "# Original wording\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "docs typo", "-m", "Harness-Trivial-Doc: README.md"]);
    const allowed = await checkProject(root, { ci: true, base });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.details.trivialDoc, "README.md");
    await writeFile(file, "# Later change\n");
    assert.equal((await checkProject(root, { ci: true, base })).ok, false);
    await writeFile(file, "# Original wording\n");
    await writeFile(path.join(root, "unexpected.mjs"), "export {};\n");
    assert.equal((await checkProject(root, { ci: true, base })).ok, false);
  } finally { await cleanup(root); }
});

test("invalid check flags cannot silently select a less strict check", async () => {
  const root = await createInstalledProject();
  try {
    for (const args of [["--c1"], ["--ci=tru"], ["--ci", "--ci=false"], ["--base", "HEAD"]]) {
      const run = spawnSync(process.execPath, [path.join(root, ".ai-harness/bin/harness.mjs"), "check", ...args, "--json"], { cwd: root, encoding: "utf8" });
      assert.equal(run.status, 1, args.join(" "));
      assert.match(run.stderr, /UNKNOWN_OPTION|INVALID_OPTION/);
    }
  } finally { await cleanup(root); }
});

test("blank required documentation cannot establish a new project baseline", async () => {
  const root = await createInstalledProject({ mode: "new", docsMode: "default" });
  try {
    await createWorkItemState(root, {
      id: "BLANK-DOC", type: "NEW_PROJECT", title: "Initial product", references: ["request"], acceptance: ["baseline is populated"],
      authorizationMode: "autonomous", authorizationSource: "fixture", architectureSource: "HUMAN_PROVIDED", architectureApproval: "fixture",
    });
    await transitionWorkItem(root, "BLANK-DOC", "BASELINING");
    for (const file of ["docs/README.md", "docs/product/overview.md", "docs/architecture/overview.md",
      "docs/versions/v1.0/README.md", "docs/versions/v1.0/STATE.md"]) {
      await writeFile(path.join(root, file), "# Filled baseline\n");
    }
    await writeFile(path.join(root, "README.md"), "  \n");
    await assert.rejects(() => completeBaseline(root, "BLANK-DOC", { evidence: ["first version"] }), /README\.md/);
  } finally { await cleanup(root); }
});
