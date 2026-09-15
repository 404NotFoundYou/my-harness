import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beginWorkItem, finishWorkItem } from "../src/compact.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { getWorkGuide } from "../src/guide.mjs";
import { sourceSnapshot, saveSnapshot, loadSnapshot } from "../src/snapshot.mjs";
import { checkProject } from "../src/checker.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

async function aliasedProject() {
  const root = await createInstalledProject();
  const holder = await mkdtemp(path.join(tmpdir(), "ai-harness-root-alias-"));
  const alias = path.join(holder, "project");
  await symlink(await realpath(root), alias, process.platform === "win32" ? "junction" : "dir");
  return { root, alias, holder };
}

async function dispose({ root, holder }) {
  assert.equal(path.dirname(path.resolve(holder)), path.resolve(tmpdir()));
  assert.ok(path.basename(holder).startsWith("ai-harness-root-alias-"));
  await rm(holder, { recursive: true, force: true });
  await cleanup(root);
}

test("root aliases preserve workflow, snapshot and full-output references through completion", async () => {
  const fixture = await aliasedProject();
  const { root, alias } = fixture;
  try {
    await writeFile(path.join(root, "app.test.mjs"), 'import assert from "node:assert/strict"; assert.equal(2+2,4); console.log("x".repeat(20000));\n');
    await beginWorkItem(alias, { id: "ALIAS", type: "ITERATION", title: "same physical project", references: ["fixture"], acceptance: ["valid output"],
      authorizationMode: "autonomous", authorizationSource: "fixture", risk: "low", approach: "preserve output", databaseEvidence: "none",
      writeScopes: ["app.test.mjs"], verification: ["node --test app.test.mjs"], docsImpact: ["N/A: unchanged"] });
    const command = await runRecordedCommand(alias, { id: "ALIAS", taskId: "T1", checkId: "V1" });
    assert.equal(command.status, "pass");
    assert.ok(command.command.stdout.truncated);
    assert.ok(command.command.stdout.artifact.startsWith(".ai-harness/work-items/ALIAS/outputs/"));
    assert.ok((await readFile(path.join(alias, command.command.stdout.artifact), "utf8")).includes("x".repeat(20000)));
    assert.ok(command.command.source.document.startsWith(".ai-harness/work-items/ALIAS/snapshots/"));
    const guide = await getWorkGuide(alias, "ALIAS");
    assert.equal(guide.resources.evidence, ".ai-harness/work-items/ALIAS/evidence.jsonl");
    assert.equal(guide.next.code, "finish-iteration");
    await finishWorkItem(alias, "ALIAS", { commandIds: [command.id], verification: "actual output checked", review: "fixture review", documentation: "N/A: unchanged", acceptance: "fixture output valid" });
    assert.equal((await checkProject(alias, { ci: true })).ok, true);
  } finally { await dispose(fixture); }
});

test("snapshot aliases allow new directories while preserving internal-link and escape rejection", async () => {
  const fixture = await aliasedProject();
  const { root, alias, holder } = fixture;
  try {
    const canonical = await realpath(root), snapshot = await sourceSnapshot(root);
    for (const [base, directory] of [
      [alias, path.join(alias, ".ai-harness/work-items/LEXICAL")],
      [alias, path.join(canonical, ".ai-harness/work-items/CANONICAL")],
      [canonical, path.join(canonical, ".ai-harness/work-items/ORDINARY")],
    ]) {
      const reference = await saveSnapshot(base, directory, snapshot);
      assert.ok(reference.document.startsWith(".ai-harness/work-items/"));
      assert.equal((await loadSnapshot(alias, reference)).digest, snapshot.digest);
    }
    await mkdir(path.join(root, "real-data"));
    await symlink(path.join(canonical, "real-data"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => saveSnapshot(alias, path.join(alias, "linked/new"), snapshot), { code: "SYMLINK_WRITE" });
    await assert.rejects(() => saveSnapshot(alias, path.join(canonical, "linked/new"), snapshot), { code: "SYMLINK_WRITE" });
    await assert.rejects(() => saveSnapshot(alias, path.join(holder, "outside"), snapshot), { code: "PATH_ESCAPE" });
  } finally { await dispose(fixture); }
});
