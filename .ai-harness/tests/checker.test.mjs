import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { cleanup, createInstalledProject, git, sourceRoot } from "./helpers.mjs";

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
