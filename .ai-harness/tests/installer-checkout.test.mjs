import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installationFiles, installRuntime, uninstallRuntime } from "../src/installer.mjs";
import { exists } from "../src/filesystem.mjs";
import { cleanup, git, sourceRoot } from "./helpers.mjs";

function commit(root) {
  git(root, ["-c", "core.autocrlf=true", "add", "."]);
  git(root, ["-c", "user.name=Harness Test", "-c", "user.email=harness-test@example.invalid", "commit", "-m", "checkout fixture"]);
}

test("source and installed Git checkouts keep receipt bytes across autocrlf settings", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-checkout-"));
  try {
    const source = path.join(directory, "source");
    await mkdir(source);
    for (const relative of await installationFiles(sourceRoot)) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await copyFile(path.join(sourceRoot, relative), path.join(source, relative));
    }
    git(source, ["init"]);
    commit(source);
    const sources = [];
    for (const setting of ["true", "false"]) {
      const checkout = path.join(directory, `source-${setting}`);
      git(directory, ["clone", "--quiet", "-c", `core.autocrlf=${setting}`, source, checkout]);
      sources.push(checkout);
    }
    const target = path.join(directory, "target");
    await mkdir(target);
    const rootAttributes = "*.txt text eol=crlf\n";
    await writeFile(path.join(target, ".gitattributes"), rootAttributes);
    const projectRules = "# Project rules\r\nKeep trailing spaces.  ";
    await writeFile(path.join(target, "AGENTS.md"), projectRules);
    await installRuntime(sources[0], target);
    assert.equal(await readFile(path.join(target, ".gitattributes"), "utf8"), rootAttributes);
    const receipt = JSON.parse(await readFile(path.join(target, ".ai-harness/install-receipt.json"), "utf8"));
    git(target, ["init"]);
    const unmanaged = [".github/workflows/custom.yml", ".github/workflows/custom/ai-harness.yml", ".github/workflows/custom/.gitattributes"];
    const attributes = git(target, ["check-attr", "text", "eol", "--", ...unmanaged]).stdout.trim().split(/\r?\n/);
    assert.equal(attributes.length, unmanaged.length * 2);
    assert.ok(attributes.every(line => line.endsWith(": unspecified")));
    // User evidence and backups must retain their original bytes, even with a root text rule.
    for (const relative of ["work-items/fixture/raw.txt", "backups/fixture/raw.txt"]) {
      await mkdir(path.dirname(path.join(target, ".ai-harness", relative)), { recursive: true });
      await writeFile(path.join(target, ".ai-harness", relative), "original\r\nbytes\r\n");
    }
    git(target, ["add", "-f", ".ai-harness/backups/fixture/raw.txt"]);
    commit(target);
    for (const setting of ["true", "false"]) {
      const checkout = path.join(directory, `target-${setting}`);
      git(directory, ["clone", "--quiet", "-c", `core.autocrlf=${setting}`, target, checkout]);
      const attributesBefore = await readFile(path.join(checkout, ".gitattributes"));
      for (const sourceCheckout of sources) {
        const preview = await uninstallRuntime(sourceCheckout, checkout, { dryRun: true });
        assert.deepEqual(preview.operations.filter(entry => entry.action === "conflict"), []);
        const installed = await installRuntime(sourceCheckout, checkout);
        assert.ok(installed.operations.every(entry => entry.action === "skip"));
        assert.deepEqual(JSON.parse(await readFile(path.join(checkout, ".ai-harness/install-receipt.json"), "utf8")), receipt);
      }
      assert.deepEqual(await readFile(path.join(checkout, ".gitattributes")), attributesBefore);
      for (const relative of ["work-items/fixture/raw.txt", "backups/fixture/raw.txt"]) {
        assert.equal(await readFile(path.join(checkout, ".ai-harness", relative), "utf8"), "original\r\nbytes\r\n");
      }
      await appendFile(path.join(checkout, ".ai-harness/src/evidence.mjs"), "\n// local change\n");
      await assert.rejects(() => installRuntime(sources[0], checkout), { code: "INSTALL_CONFLICT" });
      await assert.rejects(() => uninstallRuntime(sources[1], checkout, { confirm: true }), { code: "UNINSTALL_CONFLICT" });
      await copyFile(path.join(sources[0], ".ai-harness/src/evidence.mjs"), path.join(checkout, ".ai-harness/src/evidence.mjs"));
      const adapter = path.join(checkout, "CLAUDE.md");
      const originalAdapter = await readFile(adapter, "utf8");
      await writeFile(adapter, originalAdapter.replace(/\r?\n$/, ""));
      await assert.rejects(() => uninstallRuntime(sources[0], checkout, { confirm: true }), { code: "MANAGED_BLOCK_BOUNDARY_MODIFIED" });
      await writeFile(adapter, originalAdapter);
      await uninstallRuntime(sources[1], checkout, { confirm: true });
      assert.equal(await readFile(path.join(checkout, "AGENTS.md"), "utf8"), setting === "true" ? projectRules : projectRules.replaceAll("\r\n", "\n"));
      assert.deepEqual(await readFile(path.join(checkout, ".gitattributes")), attributesBefore);
      assert.equal(await exists(path.join(checkout, ".github/workflows/.gitattributes")), false);
    }
  } finally { await cleanup(directory); }
});

test("existing workflow attributes conflict before any installation write", async () => {
  const target = await mkdtemp(path.join(tmpdir(), "ai-harness-checkout-conflict-"));
  const relative = ".github/workflows/.gitattributes";
  try {
    await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    const original = "*.yml text eol=crlf\r\n";
    await writeFile(path.join(target, relative), original);
    const preview = await installRuntime(sourceRoot, target, { dryRun: true });
    assert.ok(preview.operations.some(entry => entry.relative === relative && entry.action === "conflict"));
    await assert.rejects(() => installRuntime(sourceRoot, target), { code: "INSTALL_CONFLICT" });
    assert.equal(await readFile(path.join(target, relative), "utf8"), original);
    assert.equal(await exists(path.join(target, "AGENTS.md")), false);
    assert.equal(await exists(path.join(target, ".ai-harness")), false);
  } finally { await cleanup(target); }
});
