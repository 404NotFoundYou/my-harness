import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { taskContext } from "../../src/context.mjs";
import { withFileLock } from "../../src/filesystem.mjs";
import { codexDriver } from "../../../benchmarks/codex-driver.mjs";

// 调研探针仅写入本次创建的系统临时目录，不改产品文件或真实工作项。
const temporaryParent = path.resolve(os.tmpdir());
const directory = await mkdtemp(path.join(temporaryParent, "harness-opt-probe-"));
const findings = [];
try {
  const lock = path.join(directory, "interrupted.lock");
  const childFile = path.join(directory, "interrupted.mjs");
  const filesystemUrl = new URL("../../src/filesystem.mjs", import.meta.url).href;
  await writeFile(childFile, `import { withFileLock } from ${JSON.stringify(filesystemUrl)};\nawait withFileLock(${JSON.stringify(lock)}, async () => { process.exit(0); });\n`);
  const child = spawnSync(process.execPath, [childFile], { shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 0, "隔离子进程必须成功到达退出点");
  const owner = JSON.parse(await readFile(lock, "utf8"));
  let acquired = false;
  let failure = null;
  try {
    await withFileLock(lock, async () => { acquired = true; }, 100);
  } catch (error) {
    failure = { code: error.code, message: error.message };
  }
  findings.push({ probe: "lock-after-owner-exit", ownerMatchesExitedChild: owner.pid === child.pid, acquired, failure });

  await mkdir(path.join(directory, "src"));
  const seeds = ["src/value.mjs", "src/Value.java", "src/value.py", "src/value.dart", "src/view.vue", "public-spec.json"];
  for (const file of seeds) await writeFile(path.join(directory, file), file.endsWith(".mjs") ? "export const value = 1;\n" : "fixture\n");
  const context = await taskContext(directory, { input: { references: seeds } }, null);
  findings.push({ probe: "explicit-context-file-types", requested: seeds, returned: context.files.map(entry => entry.path), omitted: context.omitted, notReturned: context.notReturned });

  for (const [name, prefix] of [
    ["malformed-jsonl", "broken-json-line"],
    ["terminal-failure", JSON.stringify({ type: "turn.failed", error: { message: "synthetic terminal failure" } })],
  ]) {
    const outputDirectory = path.join(directory, name);
    await mkdir(outputDirectory);
    const shim = path.join(outputDirectory, "synthetic-cli.mjs");
    await writeFile(shim, `import { writeFile } from "node:fs/promises";\nprocess.stdin.resume();\nawait writeFile(process.argv[process.argv.indexOf("-o") + 1], JSON.stringify({ completed: true, summary: "synthetic only", tests: [] }));\nconsole.log(${JSON.stringify(prefix)});\nconsole.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }));\n`);
    const result = await codexDriver(shim)({ root: directory, model: "synthetic-fixture", prompt: "Synthetic local fixture; no model service.", budget: { timeoutMs: 5000, maxToolCalls: 5, reasoning: "medium" }, outputDirectory });
    findings.push({ probe: `codex-${name}`, simulated: true, exitCode: result.exitCode, completed: result.completed, errors: result.errors, unparsedLines: result.unparsedLines ?? null });
  }
  console.log(JSON.stringify({ findings }, null, 2));
} finally {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), temporaryParent, "仅清理系统临时目录下的本次夹具");
  assert.ok(path.basename(resolved).startsWith("harness-opt-probe-"));
  await rm(resolved, { recursive: true, force: true });
}
