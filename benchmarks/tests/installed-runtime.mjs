import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "../../.ai-harness/src/filesystem.mjs";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const entry = ".ai-harness/bin/harness.mjs";
const previous = "d90227f4684001055cffd16e6138508737bc2ccc"; // 1.12.0 includes a now-retired test.

test("a downstream upgrade owns the previewed changes and passes its installed suite and merge gate", async () => {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, "ai-harness-downstream-"));
  const target = path.join(directory, "project"), old = path.join(directory, "previous");
  const git = (...args) => execFileSync("git", args, { cwd: target, encoding: "utf8", windowsHide: true }).trim();
  function cli(script, args, expected = 0) {
    const result = spawnSync(process.execPath, [script, ...args, "--json"], { cwd: target, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  }
  try {
    await mkdir(target);
    await mkdir(old);
    const archive = path.join(directory, "previous.tar");
    execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, previous, "--", ".ai-harness", ":(exclude).ai-harness/work-items", ":(exclude).ai-harness/project.json", ".github/workflows/.gitattributes", ".github/workflows/ai-harness.yml"], { cwd: sourceRoot, windowsHide: true });
    execFileSync("tar", ["-xf", archive, "-C", old], { windowsHide: true });
    git("init", "--quiet");
    git("config", "user.name", "Harness Test");
    git("config", "user.email", "harness-test@example.invalid");
    cli(path.join(old, entry), ["install", "--target", target]);
    cli(entry, ["init", "--mode", "existing", "--docs", "existing"]);
    git("add", "."); git("commit", "--quiet", "-m", "Installed 1.12.0");
    const base = git("rev-parse", "HEAD"), source = path.join(sourceRoot, entry);
    const { operations } = cli(source, ["install", "--target", target, "--dry-run"]);
    assert.ok(operations.some(op => op.action === "remove-retired"));
    assert.ok(!operations.some(op => op.action === "conflict"));
    const writes = operations.filter(op => op.action !== "skip").flatMap(op => ["--writes", op.relative]);
    const work = ["--id", "UPGRADE"];
    cli(entry, ["begin", ...work, "--type", "ITERATION", "--title", "Upgrade runtime", "--input", "Pinned distribution",
      "--acceptance", "Installed tests pass and only the previewed changes are delivered", "--authorization-source", "Isolated downstream fixture",
      "--risk", "medium", "--approach", "Apply the preview from the independent source", "--database-evidence", "File-only upgrade",
      ...writes, "--verify", JSON.stringify({ command: "node", args: [".ai-harness/tests/run.mjs"], timeoutMs: 600000 }), "--docs", "N/A: runtime distribution only"]);
    assert.deepEqual(cli(source, ["install", "--target", target]).operations, operations);
    assert.equal(await exists(path.join(target, ".github/workflows/source-tests.yml")), false);
    assert.equal(cli(entry, ["doctor"]).ok, true);
    const event = cli(entry, ["run", ...work, "--task", "T1", "--check", "V1"]);
    assert.equal(event.status, "pass");
    console.log(event.command.stdout.text.split(/\r?\n/).slice(-10).join("\n"));
    assert.equal(cli(entry, ["finish", ...work, "--command", event.id, "--verification", "Installed suite passed", "--review", "Installed operations matched the preview, including the retired file",
      "--documentation", "N/A: runtime distribution only", "--acceptance", "Installed runtime and upgrade scope verified",
      "--cleanup", "cleaned=installer retired the source-only workflow after matching its receipt", "--cleanup", "released=verified the retired workflow path is absent", "--cleanup", "retained=installer backup used for upgrade rollback"]).status, "DONE");
    git("add", "."); git("commit", "--quiet", "-m", "Deliver runtime upgrade");
    const pure = git("rev-parse", "HEAD");
    assert.equal(cli(entry, ["check", "--ci", "--base", base]).ok, true);
    git("switch", "--quiet", "-c", "mixed", base);
    git("restore", "--source", pure, "--staged", "--worktree", "--", ".");
    await writeFile(path.join(target, "business.mjs"), "export const business = true;\n");
    git("add", "business.mjs"); git("commit", "--quiet", "-m", "Mix a business change into the same upgrade commit");
    const mixed = cli(entry, ["check", "--ci", "--base", base], 1);
    assert.equal(mixed.ok, false);
    assert.deepEqual(mixed.errors, ["CI 基准后的变更缺少对应的本次交付：business.mjs"]);
  } finally {
    assert.equal(await realpath(directory), directory);
    assert.equal(path.dirname(directory), parent);
    await rm(directory, { recursive: true, maxRetries: 3 });
    assert.equal(await exists(directory), false);
  }
});
