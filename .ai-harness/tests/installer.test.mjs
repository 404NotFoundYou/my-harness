import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { cleanup, git, sourceRoot } from "./helpers.mjs";
import { installationFiles, installRuntime, initializeProject, uninstallRuntime } from "../src/installer.mjs";
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
    const manifest = JSON.parse(await readFile(path.join(sourceRoot, ".ai-harness/manifest.json"), "utf8"));
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
      assert.equal(block.version, manifest.version);
    }

    const second = await installRuntime(sourceRoot, target);
    assert.equal(second.backup, null);
    assert.ok(second.operations.every((operation) => operation.action === "skip"));
    assert.deepEqual(await readInstructions(target), installed);
  } finally {
    await cleanup(target);
  }
});

test("install refuses a concurrent edit made after the target was planned", async (context) => {
  const target = await temporaryTarget("ai-harness-install-drift-");
  const agentsPath = path.join(target, "AGENTS.md");
  const concurrent = "# Saved while installation was backing up\n";
  const rename = fsPromises.rename;
  let injected = false;
  try {
    await writeFile(agentsPath, "# Existing rules\n");
    context.mock.method(fsPromises, "rename", async (from, to) => {
      const result = await rename(from, to);
      if (!injected && String(to).includes(`${path.sep}backups${path.sep}`) && path.basename(to) === "AGENTS.md") {
        injected = true;
        await writeFile(agentsPath, concurrent);
      }
      return result;
    });
    syncBuiltinESMExports();
    await assert.rejects(() => installRuntime(sourceRoot, target), { code: "INSTALL_ROLLBACK_FAILED" });
    assert.equal(injected, true);
    assert.equal(await readFile(agentsPath, "utf8"), concurrent);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup(target);
  }
});

test("install does not replace an edit made at the final target mutation", async (context) => {
  const target = await temporaryTarget("ai-harness-install-late-drift-");
  const agentsPath = path.join(target, "AGENTS.md");
  const concurrent = "# Saved at the final target mutation\n";
  const rename = fsPromises.rename;
  const remove = fsPromises.rm;
  let injected = false;
  try {
    await writeFile(agentsPath, "# Existing rules\n");
    const inject = async () => {
      if (!injected) { injected = true; await writeFile(agentsPath, concurrent); }
    };
    context.mock.method(fsPromises, "rename", async (from, to) => {
      if (String(from) === agentsPath && String(to).includes(`${path.sep}backups${path.sep}`)) await inject();
      return rename(from, to);
    });
    context.mock.method(fsPromises, "rm", async (file, options) => {
      if (String(file) === agentsPath) await inject();
      return remove(file, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(() => installRuntime(sourceRoot, target));
    assert.equal(injected, true);
    assert.equal(await readFile(agentsPath, "utf8"), concurrent);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup(target);
  }
});

test("install rollback preserves a concurrent edit to an already installed file", async (context) => {
  const target = await temporaryTarget("ai-harness-install-rollback-drift-");
  const agentsPath = path.join(target, "AGENTS.md");
  const concurrent = "# Saved after the first installation write\n";
  const rename = fsPromises.rename;
  const hardlink = fsPromises.link;
  try {
    await writeFile(agentsPath, "# Existing rules\n");
    context.mock.method(fsPromises, "rename", async (from, to) => {
      if (path.dirname(to) === target && path.basename(to) === "CLAUDE.md") {
        await writeFile(agentsPath, concurrent);
        throw Object.assign(new Error("injected install failure"), { code: "EIO" });
      }
      return rename(from, to);
    });
    context.mock.method(fsPromises, "link", async (from, to) => {
      if (String(to) === path.join(target, "CLAUDE.md")) {
        await writeFile(agentsPath, concurrent);
        throw Object.assign(new Error("injected install failure"), { code: "EIO" });
      }
      return hardlink(from, to);
    });
    syncBuiltinESMExports();
    let failure;
    try { await installRuntime(sourceRoot, target); } catch (error) { failure = error; }
    assert.equal(failure?.code, "INSTALL_ROLLBACK_FAILED");
    assert.equal(await readFile(agentsPath, "utf8"), concurrent);
    assert.equal(await exists(path.join(target, failure.details.backup, "AGENTS.md")), true);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup(target);
  }
});

test("rollback keeps an edit made at its final target mutation", async (context) => {
  const target = await temporaryTarget("ai-harness-rollback-late-drift-");
  const agentsPath = path.join(target, "AGENTS.md");
  const concurrent = "# Saved during rollback\n";
  const rename = fsPromises.rename;
  const hardlink = fsPromises.link;
  const remove = fsPromises.rm;
  let failing = false, injected = false;
  try {
    await writeFile(agentsPath, "# Existing rules\n");
    const inject = async () => {
      if (failing && !injected) { injected = true; await writeFile(agentsPath, concurrent); }
    };
    context.mock.method(fsPromises, "rename", async (from, to) => {
      if (path.dirname(to) === target && path.basename(to) === "CLAUDE.md") {
        failing = true;
        throw Object.assign(new Error("injected install failure"), { code: "EIO" });
      }
      if (String(from) === agentsPath && String(to).includes(`${path.sep}backups${path.sep}`)) await inject();
      return rename(from, to);
    });
    context.mock.method(fsPromises, "link", async (from, to) => {
      if (String(to) === path.join(target, "CLAUDE.md")) {
        failing = true;
        throw Object.assign(new Error("injected install failure"), { code: "EIO" });
      }
      return hardlink(from, to);
    });
    context.mock.method(fsPromises, "rm", async (file, options) => {
      if (String(file) === agentsPath) await inject();
      return remove(file, options);
    });
    syncBuiltinESMExports();
    await assert.rejects(() => installRuntime(sourceRoot, target));
    assert.equal(failing, true);
    assert.equal(injected, true);
    assert.equal(await readFile(agentsPath, "utf8"), concurrent);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
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

test("installed contract keeps trivial work outside the state machine without weakening side-effect approval", async () => {
  const target = await temporaryTarget("ai-harness-trivial-contract-");
  try {
    await installRuntime(sourceRoot, target);
    const agents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    const block = inspectManagedBlock(agents, "AGENTS.md");

    assert.ok(block.body.includes("`TRIVIAL_READONLY`"));
    assert.ok(block.body.includes("`TRIVIAL_EDIT`"));
    assert.ok(block.body.includes("不运行 Runtime 命令、不创建工作项"));
    assert.ok(block.body.includes("分类不确定时也选择此类"));
    assert.ok(block.body.includes("部署、发布、生产数据"));
    assert.ok(block.body.includes("始终需要明确授权"));
    assert.ok(block.body.includes("轻量分类不能授予权限"));
  } finally {
    await cleanup(target);
  }
});

test("uninstall is previewable, recoverable and preserves project data across reinstall", async () => {
  const target = await temporaryTarget("ai-harness-uninstall-");
  const localRules = "# Product rules\n\n- Preserve application behavior.\n";
  try {
    await writeFile(path.join(target, "AGENTS.md"), localRules, "utf8");
    await installRuntime(sourceRoot, target);
    git(target, ["init"]);
    await initializeProject(target, { mode: "existing", docsMode: "existing" });
    await mkdir(path.join(target, ".ai-harness", "work-items", "AUDIT-1"), { recursive: true });
    await writeFile(path.join(target, ".ai-harness", "work-items", "AUDIT-1", "state.json"), "{}\n", "utf8");
    await writeFile(path.join(target, "project-notes.md"), "project owned\n", "utf8");
    const installedAgents = await readFile(path.join(target, "AGENTS.md"), "utf8");

    const preview = await uninstallRuntime(sourceRoot, target, { dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.ok(preview.operations.some((operation) => operation.relative === ".ai-harness/manifest.json" && operation.action === "remove-runtime"));
    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), installedAgents);
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), true);

    const removed = await uninstallRuntime(sourceRoot, target, { confirm: true });
    assert.ok(removed.backup);
    const remainingAgents = await readFile(path.join(target, "AGENTS.md"), "utf8");
    assert.equal(remainingAgents, localRules);
    assert.equal(inspectManagedBlock(remainingAgents, "AGENTS.md").present, false);
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), false);
    assert.equal(await exists(path.join(target, ".ai-harness", "install-receipt.json")), false);
    assert.equal(await exists(path.join(target, ".ai-harness", "project.json")), false);
    assert.equal(await exists(path.join(target, ".github", "workflows", "ai-harness.yml")), false);
    assert.equal(await exists(path.join(target, ".github", "workflows", ".gitattributes")), false);
    assert.equal(await exists(path.join(target, ".ai-harness", "work-items", "AUDIT-1", "state.json")), true);
    assert.equal(await exists(path.join(target, "project-notes.md")), true);
    assert.equal(
      await readFile(path.join(target, removed.backup, "AGENTS.md"), "utf8"),
      installedAgents,
    );
    assert.equal(await exists(path.join(target, removed.backup, ".ai-harness", "manifest.json")), true);
    assert.equal(await exists(path.join(target, removed.backup, ".ai-harness", "install-receipt.json")), true);

    await installRuntime(sourceRoot, target);
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), true);
    assert.equal(inspectManagedBlock(await readFile(path.join(target, "AGENTS.md"), "utf8"), "AGENTS.md").present, true);
    assert.equal(await exists(path.join(target, ".ai-harness", "work-items", "AUDIT-1", "state.json")), true);
    assert.equal(await exists(path.join(target, "project-notes.md")), true);
  } finally {
    await cleanup(target);
  }
});

test("uninstall conflicts and managed-block tampering fail before any deletion", async () => {
  const conflictTarget = await temporaryTarget("ai-harness-uninstall-conflict-");
  try {
    await installRuntime(sourceRoot, conflictTarget);
    const configPath = path.join(conflictTarget, ".ai-harness", "config.json");
    await writeFile(configPath, "{\"locallyModified\":true}\n", "utf8");
    const agents = await readFile(path.join(conflictTarget, "AGENTS.md"), "utf8");

    const preview = await uninstallRuntime(sourceRoot, conflictTarget, { dryRun: true });
    assert.ok(preview.operations.some((operation) => operation.relative === ".ai-harness/config.json" && operation.action === "conflict"));
    await assert.rejects(
      () => uninstallRuntime(sourceRoot, conflictTarget, { confirm: true }),
      { code: "UNINSTALL_CONFLICT" },
    );
    assert.equal(await readFile(path.join(conflictTarget, "AGENTS.md"), "utf8"), agents);
    assert.equal(await readFile(configPath, "utf8"), "{\"locallyModified\":true}\n");
    assert.equal(await exists(path.join(conflictTarget, ".ai-harness", "manifest.json")), true);
    assert.equal(await exists(path.join(conflictTarget, ".ai-harness", "backups")), false);
  } finally {
    await cleanup(conflictTarget);
  }

  const tamperedTarget = await temporaryTarget("ai-harness-uninstall-tampered-");
  try {
    await installRuntime(sourceRoot, tamperedTarget);
    const agentsPath = path.join(tamperedTarget, "AGENTS.md");
    const tampered = (await readFile(agentsPath, "utf8")).replace("## 启动协议", "## modified");
    await writeFile(agentsPath, tampered, "utf8");

    await assert.rejects(
      () => uninstallRuntime(sourceRoot, tamperedTarget, { confirm: true }),
      { code: "MANAGED_BLOCK_MODIFIED" },
    );
    assert.equal(await readFile(agentsPath, "utf8"), tampered);
    assert.equal(await exists(path.join(tamperedTarget, ".ai-harness", "manifest.json")), true);
    assert.equal(await exists(path.join(tamperedTarget, ".ai-harness", "backups")), false);
  } finally {
    await cleanup(tamperedTarget);
  }
});

test("uninstall version mismatch fails closed without recommending self-uninstall", async () => {
  const target = await temporaryTarget("ai-harness-uninstall-version-");
  try {
    await installRuntime(sourceRoot, target);
    const manifestPath = path.join(target, ".ai-harness", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "0.0.0-test-mismatch";
    const mismatched = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, mismatched, "utf8");

    await assert.rejects(
      () => uninstallRuntime(sourceRoot, target, { confirm: true }),
      (error) => {
        assert.equal(error.code, "UNINSTALL_VERSION_MISMATCH");
        assert.match(error.message, /独立 Harness 源仓库/);
        return true;
      },
    );
    assert.equal(await readFile(manifestPath, "utf8"), mismatched);
    assert.equal(await exists(path.join(target, ".ai-harness", "backups")), false);
  } finally {
    await cleanup(target);
  }
});

test("uninstall restores pre-existing whitespace bytes instead of deleting the rules file", async () => {
  const target = await temporaryTarget("ai-harness-uninstall-whitespace-");
  const original = "\uFEFF \r\n";
  try {
    await writeFile(path.join(target, "AGENTS.md"), original, "utf8");
    await installRuntime(sourceRoot, target);
    await uninstallRuntime(sourceRoot, target, { confirm: true });

    assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), original);
  } finally {
    await cleanup(target);
  }
});

test("uninstall uses the install receipt instead of a dirty source directory listing", async () => {
  const source = await temporaryTarget("ai-harness-uninstall-source-");
  const target = await temporaryTarget("ai-harness-uninstall-receipt-");
  const policyRelative = ".ai-harness/src/policy.mjs";
  const extraRelative = ".ai-harness/local-extra.txt";
  try {
    await cp(path.join(sourceRoot, ".ai-harness"), path.join(source, ".ai-harness"), { recursive: true });
    await mkdir(path.join(source, ".github", "workflows"), { recursive: true });
    await cp(
      path.join(sourceRoot, ".github", "workflows", "ai-harness.yml"),
      path.join(source, ".github", "workflows", "ai-harness.yml"),
    );
    await cp(
      path.join(sourceRoot, ".github", "workflows", ".gitattributes"),
      path.join(source, ".github", "workflows", ".gitattributes"),
    );
    await installRuntime(source, target);
    await writeFile(path.join(source, extraRelative), "source-local\n", "utf8");
    await writeFile(path.join(target, extraRelative), "source-local\n", "utf8");
    await rm(path.join(source, policyRelative));

    await assert.rejects(
      () => uninstallRuntime(source, target, { confirm: true }),
      { code: "UNINSTALL_SOURCE_MISMATCH" },
    );
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), true);
    assert.equal(await readFile(path.join(target, extraRelative), "utf8"), "source-local\n");

    await cp(path.join(sourceRoot, policyRelative), path.join(source, policyRelative));
    await uninstallRuntime(source, target, { confirm: true });
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), false);
    assert.equal(await readFile(path.join(target, extraRelative), "utf8"), "source-local\n");
  } finally {
    await cleanup(source);
    await cleanup(target);
  }
});

test("uninstall revalidates target snapshots after backup before deleting", async () => {
  const target = await temporaryTarget("ai-harness-uninstall-drift-");
  try {
    await installRuntime(sourceRoot, target);
    const agentsPath = path.join(target, "AGENTS.md");
    const concurrentContent = `${await readFile(agentsPath, "utf8")}\n# Concurrent project save\n`;

    await assert.rejects(
      () => uninstallRuntime(sourceRoot, target, {
        confirm: true,
        hooks: {
          afterBackup: async () => writeFile(agentsPath, concurrentContent, "utf8"),
        },
      }),
      { code: "UNINSTALL_TARGET_CHANGED" },
    );
    assert.equal(await readFile(agentsPath, "utf8"), concurrentContent);
    assert.equal(await exists(path.join(target, ".ai-harness", "manifest.json")), true);
    assert.equal(await exists(path.join(target, ".ai-harness", "backups")), false);
  } finally {
    await cleanup(target);
  }
});

test("uninstall rolls back partial application and retains backup if rollback fails", async () => {
  const rollbackTarget = await temporaryTarget("ai-harness-uninstall-rollback-");
  try {
    await installRuntime(sourceRoot, rollbackTarget);
    const before = await readInstructions(rollbackTarget);
    const configBefore = await readFile(path.join(rollbackTarget, ".ai-harness", "config.json"), "utf8");
    await assert.rejects(
      () => uninstallRuntime(sourceRoot, rollbackTarget, {
        confirm: true,
        hooks: {
          beforeApply: ({ operation }) => {
            if (operation.relative === ".ai-harness/src/policy.mjs") throw new Error("injected apply failure");
          },
        },
      }),
      { code: "UNINSTALL_ROLLED_BACK" },
    );
    assert.deepEqual(await readInstructions(rollbackTarget), before);
    assert.equal(await readFile(path.join(rollbackTarget, ".ai-harness", "config.json"), "utf8"), configBefore);
    assert.equal(await exists(path.join(rollbackTarget, ".ai-harness", "manifest.json")), true);
    assert.equal(await exists(path.join(rollbackTarget, ".ai-harness", "install-receipt.json")), true);
    assert.equal(await exists(path.join(rollbackTarget, ".ai-harness", "backups")), false);
  } finally {
    await cleanup(rollbackTarget);
  }

  const failedRollbackTarget = await temporaryTarget("ai-harness-uninstall-rollback-failed-");
  try {
    await installRuntime(sourceRoot, failedRollbackTarget);
    const concurrentContent = "# Concurrent content after uninstall started\n";
    let failure;
    try {
      await uninstallRuntime(sourceRoot, failedRollbackTarget, {
        confirm: true,
        hooks: {
          beforeApply: ({ operation }) => {
            if (operation.relative === ".ai-harness/src/policy.mjs") throw new Error("injected apply failure");
          },
          beforeRollback: async ({ operation }) => {
            if (operation.relative === "AGENTS.md") {
              await writeFile(path.join(failedRollbackTarget, "AGENTS.md"), concurrentContent, "utf8");
            }
          },
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.code, "UNINSTALL_ROLLBACK_FAILED");
    assert.ok(failure?.details?.backup);
    assert.equal(await readFile(path.join(failedRollbackTarget, "AGENTS.md"), "utf8"), concurrentContent);
    assert.equal(
      await exists(path.join(failedRollbackTarget, failure.details.backup, "AGENTS.md")),
      true,
    );
  } finally {
    await cleanup(failedRollbackTarget);
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

test("installer rejects a symlinked or junction-backed runtime root", async (context) => {
  const source = await temporaryTarget("ai-harness-symlink-runtime-source-");
  const target = await temporaryTarget("ai-harness-symlink-runtime-target-");
  try {
    try {
      await symlink(path.join(sourceRoot, ".ai-harness"), path.join(source, ".ai-harness"), "junction");
    } catch (error) {
      context.skip(`当前平台无法创建测试链接：${error.code}`);
      return;
    }

    await assert.rejects(() => installRuntime(source, target), { code: "SOURCE_SYMLINK" });
    assert.equal(await exists(path.join(target, "AGENTS.md")), false);
  } finally {
    await cleanup(source);
    await cleanup(target);
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

test("new project init refuses a linked docs directory without writing outside the project", async (context) => {
  const target = await temporaryTarget("ai-harness-init-link-");
  const outside = await temporaryTarget("ai-harness-init-outside-");
  try {
    await installRuntime(sourceRoot, target);
    git(target, ["init"]);
    try {
      await symlink(outside, path.join(target, "docs"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`Current platform cannot create a directory link: ${error.code}`);
      return;
    }
    await assert.rejects(() => initializeProject(target, { mode: "new", docsMode: "default" }), { code: "SYMLINK_WRITE" });
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await exists(path.join(target, ".ai-harness", "project.json")), false);
  } finally {
    await cleanup(target);
    await cleanup(outside);
  }
});

test("new project init never copies through a docs directory linked during template preparation", async (context) => {
  const target = await temporaryTarget("ai-harness-init-swap-");
  const outside = await temporaryTarget("ai-harness-init-swap-outside-");
  const read = fsPromises.readFile;
  let linked = false;
  try {
    await installRuntime(sourceRoot, target);
    git(target, ["init"]);
    context.mock.method(fsPromises, "readFile", async (file, ...args) => {
      const content = await read(file, ...args);
      if (!linked && String(file).includes(`${path.sep}templates${path.sep}new-project${path.sep}docs${path.sep}`)) {
        linked = true;
        await symlink(outside, path.join(target, "docs"), process.platform === "win32" ? "junction" : "dir");
      }
      return content;
    });
    syncBuiltinESMExports();
    await assert.rejects(() => initializeProject(target, { mode: "new", docsMode: "default" }));
    assert.equal(linked, true);
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await exists(path.join(target, ".ai-harness", "project.json")), false);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup(target);
    await cleanup(outside);
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

test("default docs mode refuses an existing docs directory without changing its contents", async () => {
  const target = await temporaryTarget("ai-harness-existing-docs-");
  try {
    await installRuntime(sourceRoot, target);
    git(target, ["init"]);
    await mkdir(path.join(target, "docs"));
    await writeFile(path.join(target, "docs", "notes.md"), "local notes\n");
    await assert.rejects(() => initializeProject(target, { mode: "new", docsMode: "default" }), { code: "DOCS_CONFLICT" });
    assert.deepEqual(await readdir(path.join(target, "docs")), ["notes.md"]);
    assert.equal(await readFile(path.join(target, "docs", "notes.md"), "utf8"), "local notes\n");
    assert.equal(await exists(path.join(target, ".ai-harness", "project.json")), false);
  } finally { await cleanup(target); }
});

test("default docs refuses a linked backup parent before writing any template outside the project", async () => {
  const target = await temporaryTarget("ai-harness-init-backup-link-");
  const outside = await temporaryTarget("ai-harness-init-backup-outside-");
  try {
    await installRuntime(sourceRoot, target);
    git(target, ["init"]);
    await writeFile(path.join(target, ".git", "info", "exclude"), "\n.ai-harness/backups\n", { flag: "a" });
    await symlink(outside, path.join(target, ".ai-harness", "backups"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => initializeProject(target, { mode: "new", docsMode: "default" }), { code: "SYMLINK_WRITE" });
    assert.deepEqual(await readdir(outside), [], "rejection must happen before the first external write");
    assert.equal(await exists(path.join(target, "docs")), false);
    assert.equal(await exists(path.join(target, ".ai-harness", "project.json")), false);
  } finally { await cleanup(target); await cleanup(outside); }
});

test("template preparation cannot redirect staging or remove a concurrent backup link", async (context) => {
  const target = await temporaryTarget("ai-harness-init-backup-swap-");
  const outside = await temporaryTarget("ai-harness-init-backup-swap-outside-");
  const read = fsPromises.readFile;
  const backupParent = path.join(target, ".ai-harness", "backups");
  let injected = false;
  try {
    await installRuntime(sourceRoot, target);
    git(target, ["init"]);
    context.mock.method(fsPromises, "readFile", async (file, ...args) => {
      const content = await read(file, ...args);
      if (!injected && String(file).includes(path.join("templates", "new-project", "docs") + path.sep)) {
        injected = true;
        await symlink(outside, backupParent, process.platform === "win32" ? "junction" : "dir");
      }
      return content;
    });
    syncBuiltinESMExports();
    await assert.rejects(() => initializeProject(target, { mode: "new", docsMode: "default" }), { code: "SYMLINK_WRITE" });
    assert.equal(injected, true);
    assert.deepEqual(await readdir(outside), [], "a staging-parent swap must never receive template bytes");
    assert.equal((await fsPromises.lstat(backupParent)).isSymbolicLink(), true, "cleanup must preserve a concurrently created link");
    assert.equal(await exists(path.join(target, ".ai-harness", "project.json")), false);
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await cleanup(target); await cleanup(outside);
  }
});

for (const phase of ["publication", "later failure"]) {
  for (const kind of ["directory", "link"]) {
    test(`rollback preserves a concurrent ${kind} at its original path after ${phase}`, async (context) => {
      const target = await temporaryTarget("ai-harness-install-object-drift-");
      const outside = await temporaryTarget("ai-harness-install-object-outside-");
      const agentsPath = path.join(target, "AGENTS.md");
      const original = "# Existing user rules\n";
      const hardlink = fsPromises.link;
      let injected = false;
      try {
        await writeFile(agentsPath, original);
        await writeFile(path.join(outside, "notes.md"), "concurrent user data\n");
        context.mock.method(fsPromises, "link", async (from, to) => {
          const trigger = phase === "publication" ? agentsPath : path.join(target, "CLAUDE.md");
          if (!injected && String(to) === trigger) {
            injected = true;
            if (phase === "later failure") await fsPromises.unlink(agentsPath);
            if (kind === "directory") {
              await mkdir(agentsPath);
              await writeFile(path.join(agentsPath, "notes.md"), "concurrent user data\n");
            } else await symlink(outside, agentsPath, process.platform === "win32" ? "junction" : "dir");
            if (phase === "later failure") throw Object.assign(new Error("controlled later install failure"), { code: "EIO" });
          }
          return hardlink(from, to);
        });
        syncBuiltinESMExports();
        let failure;
        try { await installRuntime(sourceRoot, target); } catch (error) { failure = error; }
        assert.equal(injected, true);
        assert.equal(failure?.code, "INSTALL_ROLLBACK_FAILED");
        const info = await fsPromises.lstat(agentsPath);
        assert.equal(kind === "link" ? info.isSymbolicLink() : info.isDirectory(), true);
        assert.equal(await readFile(path.join(agentsPath, "notes.md"), "utf8"), "concurrent user data\n",
          "rollback must keep foreign objects usable through their original path");
        assert.equal(await readFile(path.join(target, failure.details.backup, "AGENTS.md"), "utf8"), original);
      } finally {
        context.mock.restoreAll(); syncBuiltinESMExports();
        await cleanup(target); await cleanup(outside);
      }
    });
  }
}

test("staging cleanup failure after publication cannot report a rollback while leaving installed files", async (context) => {
  const target = await temporaryTarget("ai-harness-install-stage-failure-");
  const remove = fsPromises.rm;
  const unlink = fsPromises.unlink;
  let injected = false;
  const failCleanup = () => {
    injected = true;
    throw Object.assign(new Error("controlled staging cleanup failure"), { code: "EIO" });
  };
  try {
    context.mock.method(fsPromises, "unlink", async (file, ...args) => {
      if (!injected && String(file).includes(path.sep + ".staged" + path.sep)) failCleanup();
      return unlink(file, ...args);
    });
    context.mock.method(fsPromises, "rm", async (file, ...args) => {
      if (!injected && path.basename(String(file)) === ".staged") failCleanup();
      return remove(file, ...args);
    });
    syncBuiltinESMExports();
    let failure;
    try { await installRuntime(sourceRoot, target); } catch (error) { failure = error; }
    assert.equal(injected, true);
    assert.equal(failure?.code, "INSTALL_ROLLED_BACK");
    const files = [...await installationFiles(sourceRoot), "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".ai-harness/install-receipt.json"];
    for (const relative of files) assert.equal(await exists(path.join(target, relative)), false,
      "successful rollback must undo every published file: " + relative);
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await cleanup(target);
  }
});
