import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { checkProject } from "../src/checker.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { exists } from "../src/filesystem.mjs";
import {
  addAnalysisConclusion,
  completeBaseline,
  createWorkItemState,
  recordResult,
  transitionWorkItem,
} from "../src/workflow.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

async function analyzing(root, id) {
  await createWorkItemState(root, {
    id,
    type: "ANALYSIS",
    title: "record current command evidence",
    references: ["user question"],
    acceptance: ["answer cites current command evidence"],
    nonGoals: ["product edits"],
    authorizationMode: "approval-required",
    authorizationSource: "read-only investigation",
  });
  await transitionWorkItem(root, id, "BASELINING");
  await completeBaseline(root, id, { evidence: ["current checkout"] });
  await transitionWorkItem(root, id, "ANALYZING");
}

test("ANALYSIS records an allow command and binds its current evidence without a plan", async () => {
  const root = await createInstalledProject();
  try {
    await analyzing(root, "ANALYSIS-COMMAND");
    const command = await runRecordedCommand(root, { id: "ANALYSIS-COMMAND", command: process.execPath, args: ["--version"] });
    assert.equal(command.status, "pass");
    assert.equal(command.taskId, null);
    assert.deepEqual(command.command.checkIds, []);
    assert.equal("planDigest" in command.command, false);
    const conclusion = await addAnalysisConclusion(root, "ANALYSIS-COMMAND", {
      status: "PROVEN",
      text: "the current Node runtime responds",
      commandRefs: [command.id],
    });
    assert.deepEqual(conclusion.commands, [command.id]);
    assert.deepEqual(conclusion.evidence, []);
    await recordResult(root, "ANALYSIS-COMMAND", { kind: "analysis", status: "pass", summary: "answer is evidence-backed" });
    await transitionWorkItem(root, "ANALYSIS-COMMAND", "ANSWERED");
    assert.deepEqual((await checkProject(root, { ci: true })).errors, []);
  } finally { await cleanup(root); }
});

test("ANALYSIS rejects task/check bindings and commands outside the allow policy", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, {
      id: "ANALYSIS-EARLY",
      type: "ANALYSIS",
      title: "wrong stage",
      references: ["user question"],
      acceptance: ["fail explicitly"],
      nonGoals: [],
      authorizationMode: "approval-required",
      authorizationSource: "read-only investigation",
    });
    await assert.rejects(
      () => runRecordedCommand(root, { id: "ANALYSIS-EARLY", command: process.execPath, args: ["--version"] }),
      { code: "WRONG_STAGE" },
    );
    await analyzing(root, "ANALYSIS-BOUNDARY");
    await assert.rejects(
      () => runRecordedCommand(root, { id: "ANALYSIS-BOUNDARY", taskId: "T1", command: process.execPath, args: ["--version"] }),
      { code: "ANALYSIS_COMMAND_SCOPE" },
    );
    await assert.rejects(
      () => runRecordedCommand(root, { id: "ANALYSIS-BOUNDARY", checkId: "V1" }),
      { code: "ANALYSIS_CHECK_NOT_ALLOWED" },
    );
    await assert.rejects(
      () => runRecordedCommand(root, { id: "ANALYSIS-BOUNDARY", command: process.execPath, args: ["--eval", "console.log(1)"] }),
      { code: "COMMAND_REQUIRES_APPROVAL" },
    );
  } finally { await cleanup(root); }
});

test("ANALYSIS rejects write-capable test commands before they can change product source", async () => {
  const root = await createInstalledProject();
  try {
    await writeFile(path.join(root, "mutating.test.mjs"), 'import { writeFile } from "node:fs/promises";\nawait writeFile("changed-by-analysis.txt", "changed\\n");\n');
    await analyzing(root, "ANALYSIS-MUTATION");
    await assert.rejects(
      () => runRecordedCommand(root, { id: "ANALYSIS-MUTATION", command: process.execPath, args: ["--test", "mutating.test.mjs"] }),
      { code: "COMMAND_DENIED" },
    );
    assert.equal(await exists(path.join(root, "changed-by-analysis.txt")), false);
  } finally { await cleanup(root); }
});

test("ANALYSIS command evidence becomes stale after a later product edit", async () => {
  const root = await createInstalledProject();
  try {
    await analyzing(root, "ANALYSIS-STALE");
    const command = await runRecordedCommand(root, { id: "ANALYSIS-STALE", command: process.execPath, args: ["--version"] });
    await addAnalysisConclusion(root, "ANALYSIS-STALE", { status: "PROVEN", text: "current runtime", commandRefs: [command.id] });
    await recordResult(root, "ANALYSIS-STALE", { kind: "analysis", status: "pass", summary: "answer ready" });
    await writeFile(path.join(root, "later-change.txt"), "changed\n");
    await assert.rejects(() => transitionWorkItem(root, "ANALYSIS-STALE", "ANSWERED"), { code: "ANALYSIS_COMMAND_EVIDENCE_INVALID" });
  } finally { await cleanup(root); }
});
