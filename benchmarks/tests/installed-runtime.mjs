import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exists } from "../../.ai-harness/src/filesystem.mjs";

const source = fileURLToPath(new URL("../../.ai-harness/bin/harness.mjs", import.meta.url));
const parent = await realpath(tmpdir());
const target = await mkdtemp(path.join(parent, "ai-harness-downstream-"));
try {
  execFileSync(process.execPath, [source, "install", "--target", target], { windowsHide: true });
  assert.equal(await exists(path.join(target, ".github/workflows/source-tests.yml")), false);
  execFileSync(process.execPath, [".ai-harness/tests/run.mjs"], { cwd: target, stdio: "inherit", windowsHide: true });
} finally {
  assert.equal(await realpath(target), target);
  assert.equal(path.dirname(target), parent);
  await rm(target, { recursive: true, maxRetries: 3 });
  assert.equal(await exists(target), false);
}
