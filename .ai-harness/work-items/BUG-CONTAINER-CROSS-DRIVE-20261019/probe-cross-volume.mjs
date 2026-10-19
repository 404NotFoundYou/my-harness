import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadContainerRuntime } from "../../../benchmarks/codex-container.mjs";

const item = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = await realpath(tmpdir());
const workspace = await realpath(await mkdtemp(path.join(temporaryRoot, "ai-harness-cross-volume-")));
const probeId = randomUUID();
const outputDirectory = path.join(item, `probe-output-${probeId}`);
const manifest = path.join(item, "../ANALYSIS-DRIVER-LOOPBACK-20261019/fixture-runtime.json");
const containers = () => execFileSync("docker", ["container", "ls", "--all", "--quiet"], { encoding: "utf8", timeout: 30000 })
  .trim().split(/\r?\n/).filter(Boolean).sort();
const before = containers();
let launch;
try {
  assert.equal(process.platform, "win32");
  assert.notEqual(path.parse(workspace).root.toLowerCase(), path.parse(outputDirectory).root.toLowerCase());
  await mkdir(outputDirectory);
  const selected = await loadContainerRuntime(manifest);
  launch = await selected.runtime.prepare({ root: workspace, outputDirectory, args: ["--version"] });
  assert.equal(launch.command, "docker");
  const execution = spawnSync(launch.command, launch.args, { cwd: launch.cwd, shell: false, windowsHide: true,
    encoding: "utf8", timeout: 30000 });
  assert.equal(execution.status, 0, execution.stderr);
  assert.match(execution.stdout, /codex-cli 0\.156\.0/);
  assert.equal(launch.cleanup(), null);
  launch = null;
  assert.deepEqual(containers(), before);
  const result = { imageId: selected.identity.imageId, workspaceVolume: path.parse(workspace).root,
    outputVolume: path.parse(outputDirectory).root, mountsAccepted: true, containerExecuted: true,
    containersUnchanged: true, modelCalls: 0 };
  await writeFile(path.join(item, `probe-result-${probeId}.json`), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(result));
} finally {
  if (launch) assert.equal(launch.cleanup(), null);
  assert.deepEqual(containers(), before);
  const resolved = await realpath(workspace);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert.ok(path.basename(resolved).startsWith("ai-harness-cross-volume-"));
  await rm(resolved, { recursive: true, force: true });
}
