import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, git, sourceRoot } from "./helpers.mjs";
import { installationFiles, installRuntime, initializeProject } from "../src/installer.mjs";
import { exists } from "../src/filesystem.mjs";
import { inspectManagedBlock } from "../src/managed-block.mjs";

async function temporaryTarget(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function readInstructions(root) {
  return Object.fromEntries(
    await Promise.all(
      ["AGENTS.md", "CLAUDE.md", "GEMINI.md"].map(async (relative) => [
        relative,
        await readFile(path.join(root, relative), "utf8"),
      ]),
    ),
  );
}

test("existing instruction files are merged losslessly and reinstall is byte-idempotent", async () => {
  const target = await temporaryTarget("ai-harness-existing-rules-");
  const originals = {
    "AGENTS.md": "\uFEFF# Existing project rules\r\n\r\n- Keep the public API stable.",
    "CLAUDE.md": "# Claude project context\r\n\r\nUse the repository conventions.",
    "GEMINI.md": "# Gemini project context\n\nPreserve generated files.",
  };
  try {
    for (const [relative, content] of Object.entries(originals)) {
      await writeFile(path.join(target, relative), content, "utf8");
    }

    const dryRun = await installRuntime(sourceRoot, target, { dryRun: true });
    for (const relative of Object.keys(originals)) {
      assert.deepEqual(
        dryRun.operations.find((operation) => operation.relative === relative),
        {
          relative,
          action: "merge",
          managed: true,
          preservedExisting: true,
          conflictReviewRequired: true,
        },
      );
      assert.equal(await readFile(path.join(target, relative), "utf8"), originals[relative]);
    }

    const first = await installRuntime(sourceRoot, target);
    assert.ok(first.backup);
    const installed = await readInstructions(target);
    for (const [relative, original] of Object.entries(originals)) {
      assert.ok(installed[relative].startsWith(original));
      assert.equal(await readFile(path.join(target, first.backup, relative), "utf8"), original);
      const block = inspectManagedBlock(installed[relative], relative);
      assert.equal(block.present, true);
      assert.equal(block.hashValid, true);
      assert.equal(block.version, "1.0.0");
    }

    const second = await installRuntime(sourceRoot, target);
    assert.equal(second.backup, null);
    assert.ok(second.operations.every((operation) => operation.action === "skip"));
    assert.deepEqual(await readInstructions(target), installed);
  } finally {
    await cleanup(target);
  }
});

test("compatible Claude and Gemini imports remain byte-identical", async () => {
  const target = await temporaryTarget("ai-harness-compatible-imports-");
  const claude = "# Local Claude rules\n\n@AGENTS.md\n";
  const gemini = "# Local Gemini rules\r\n\r\n@./AGENTS.md\r\n";
  try {
    await writeFile(path.join(target, "AGENTS.md"), "# Product-specific rules\n", "utf8");
    await writeFile(path.join(target, "CLAUDE.md"), claude, "utf8");
    await writeFile(path.join(target, "GEMINI.md"), gemini, "utf8");

    const result = await installRuntime(sourceRoot, target);
    for (const [relative, expected] of [["CLAUDE.md", claude], ["GEMINI.md", gemini]]) {
      assert.equal(await readFile(path.join(target, relative), "utf8"), expected);
      assert.deepEqual(result.operations.find((operation) => operation.relative === relative), {
        relative,
        action: "skip",
        managed: false,
        compatibleExisting: true,
      });
    }
  } finally {
    await cleanup(target);
  }
});

test("modified managed content fails closed and force repairs only the managed block", async () => {
  const target = await temporaryTarget("ai-harness-managed-repair-");
  const localRules = "# Local rules\n\n- Never rename the public package.\n";
  try {
    await writeFile(path.join(target, "AGENTS.md"), localRules, "utf8");
    await installRuntime(sourceRoot, target);
    const installed = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const tampered = installed.replace("## 开发门禁", "## 被手工修改的开发门禁");
    assert.notEqual(tampered, installed);
    await writeFile(path.join(target, "AGENTS.md"), tampered, "utf8");

    await assert.rejects(() => installRuntime(sourceRoot, target), { code: "MANAGED_BLOCK_MODIFIED" });
    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), tampered);

    const repaired = await installRuntime(sourceRoot, target, { force: true });
    assert.equal(
      repaired.operations.find((operation) => operation.relative === "AGENTS.md").action,
      "repair-managed",
    );
    assert.equal(await readFile(path.join(target, repaired.backup, "AGENTS.md"), "utf8"), tampered);
    const repairedContent = await readFile(path.join(target, "AGENTS.md"), "utf8");
    assert.ok(repairedContent.startsWith(localRules));
    assert.equal(inspectManagedBlock(repairedContent, "AGENTS.md").hashValid, true);
  } finally {
    await cleanup(target);
  }
});

test("malformed or duplicate managed markers fail even with force", async () => {
  const target = await temporaryTarget("ai-harness-malformed-markers-");
  try {
    await installRuntime(sourceRoot, target);
    const agentsPath = path.join(target, "AGENTS.md");
    const valid = await readFile(agentsPath, "utf8");
    const malformed = `${valid}\n${valid}`;
    await writeFile(agentsPath, malformed, "utf8");

    await assert.rejects(() => installRuntime(sourceRoot, target), { code: "MANAGED_BLOCK_MALFORMED" });
    await assert.rejects(() => installRuntime(sourceRoot, target, { force: true }), {
      code: "MANAGED_BLOCK_MALFORMED",
    });
    assert.equal(await readFile(agentsPath, "utf8"), malformed);
  } finally {
    await cleanup(target);
  }
});

test("ordinary runtime conflicts prevent every planned instruction merge before writes", async () => {
  const target = await temporaryTarget("ai-harness-preflight-");
  const localRules = "# Rules that must not be touched\n";
  try {
    await writeFile(path.join(target, "AGENTS.md"), localRules, "utf8");
    await mkdir(path.join(target, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(target, ".github", "workflows", "ai-harness.yml"), "name: local\n", "utf8");

    await assert.rejects(() => installRuntime(sourceRoot, target), { code: "INSTALL_CONFLICT" });
    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), localRules);
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), false);
  } finally {
    await cleanup(target);
  }
});

test("installer rejects a source workflow reached through a symlink or junction", async (context) => {
  const source = await temporaryTarget("ai-harness-symlink-source-");
  const target = await temporaryTarget("ai-harness-symlink-target-");
  const outside = await temporaryTarget("ai-harness-symlink-outside-");
  try {
    await cp(path.join(sourceRoot, ".ai-harness"), path.join(source, ".ai-harness"), { recursive: true });
    await mkdir(path.join(outside, "workflows"), { recursive: true });
    await writeFile(path.join(outside, "workflows", "ai-harness.yml"), "name: outside\n", "utf8");
    try {
      await symlink(outside, path.join(source, ".github"), "junction");
    } catch (error) {
      context.skip(`当前平台无法创建测试链接：${error.code}`);
      return;
    }

    await assert.rejects(() => installRuntime(source, target), { code: "SOURCE_SYMLINK" });
    assert.equal(await exists(path.join(target, "AGENTS.md")), false);
  } finally {
    await cleanup(source);
    await cleanup(target);
    await cleanup(outside);
  }
});

test("force replaces ordinary runtime conflicts but still merges and backs up local rules", async () => {
  const target = await temporaryTarget("ai-harness-force-");
  const localRules = "# Local rules\n";
  const localWorkflow = "name: local workflow\n";
  try {
    await writeFile(path.join(target, "AGENTS.md"), localRules, "utf8");
    await mkdir(path.join(target, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(target, ".github", "workflows", "ai-harness.yml"), localWorkflow, "utf8");

    const result = await installRuntime(sourceRoot, target, { force: true });
    assert.ok(result.backup);
    assert.equal(await readFile(path.join(target, result.backup, "AGENTS.md"), "utf8"), localRules);
    assert.equal(
      await readFile(path.join(target, result.backup, ".github", "workflows", "ai-harness.yml"), "utf8"),
      localWorkflow,
    );
    assert.ok((await readFile(path.join(target, "AGENTS.md"), "utf8")).startsWith(localRules));
    assert.equal(
      result.operations.find((operation) => operation.relative === ".github/workflows/ai-harness.yml").action,
      "replace",
    );
    assert.equal((await installationFiles(target)).some((relative) => relative.startsWith(".ai-harness/backups/")), false);
  } finally {
    await cleanup(target);
  }
});

test("redistribution uses canonical payload and never propagates source-project rules", async () => {
  const first = await temporaryTarget("ai-harness-source-project-");
  const second = await temporaryTarget("ai-harness-destination-project-");
  const firstRules = "# Project Alpha private rules\n";
  const secondRules = "# Project Beta private rules\n";
  try {
    await writeFile(path.join(first, "AGENTS.md"), firstRules, "utf8");
    await installRuntime(sourceRoot, first);
    await writeFile(path.join(second, "AGENTS.md"), secondRules, "utf8");

    await installRuntime(first, second);
    const installed = await readFile(path.join(second, "AGENTS.md"), "utf8");
    assert.ok(installed.startsWith(secondRules));
    assert.equal(installed.includes(firstRules.trim()), false);
    assert.equal(inspectManagedBlock(installed, "AGENTS.md").hashValid, true);
  } finally {
    await cleanup(first);
    await cleanup(second);
  }
});

test("oversized merged AGENTS fails before any file is written", async () => {
  const target = await temporaryTarget("ai-harness-large-rules-");
  const oversized = `# Existing rules\n${"x".repeat(32768)}\n`;
  try {
    await writeFile(path.join(target, "AGENTS.md"), oversized, "utf8");
    await assert.rejects(() => installRuntime(sourceRoot, target), { code: "ROOT_INSTRUCTIONS_TOO_LARGE" });
    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), oversized);
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), false);
  } finally {
    await cleanup(target);
  }
});

test("an existing empty instruction file is backed up before adoption", async () => {
  const target = await temporaryTarget("ai-harness-empty-rules-");
  try {
    await writeFile(path.join(target, "AGENTS.md"), "", "utf8");
    const result = await installRuntime(sourceRoot, target);
    assert.ok(result.backup);
    assert.equal(await readFile(path.join(target, result.backup, "AGENTS.md"), "utf8"), "");
  } finally {
    await cleanup(target);
  }
});

test("new project init creates templates but refuses conflicting docs", async () => {
  const target = await temporaryTarget("ai-harness-new-");
  try {
    await installRuntime(sourceRoot, target);
    git(target, ["init"]);
    await initializeProject(target, { mode: "new", docsMode: "default" });
    assert.equal(await exists(path.join(target, "docs", "versions", "v1.0", "STATE.md")), true);
  } finally {
    await cleanup(target);
  }

  const conflicting = await temporaryTarget("ai-harness-doc-conflict-");
  try {
    await installRuntime(sourceRoot, conflicting);
    git(conflicting, ["init"]);
    await writeFile(path.join(conflicting, "README.md"), "existing project\n", "utf8");
    await assert.rejects(
      () => initializeProject(conflicting, { mode: "new", docsMode: "default" }),
      { code: "DOCS_CONFLICT" },
    );
    assert.equal(await exists(path.join(conflicting, ".ai-harness", "project.json")), false);
  } finally {
    await cleanup(conflicting);
  }
});
