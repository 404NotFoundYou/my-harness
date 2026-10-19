import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

const docker = process.argv[2];
assert.ok(path.isAbsolute(docker), "Explicit Docker CLI path required");
const reportFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "forced-cleanup-result.json");
const image = "ai-harness/codex@sha256:7da46787f876ed2bca2214cad59c44d1f1876f6639962390d653e3588b941c74";
const name = `ai-harness-codex-cutoff-${randomUUID()}`;
const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), image, actualModelCalls: 0, providerRequests: 0,
  purpose: "Synthetic long-running Node process; Docker kill/rm only, not the Codex driver timer.", cleanup: {}, verified: false };
let created = false, before;
function invoke(args, timeout = 30000) {
  const result = spawnSync(docker, args, { encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, signal: result.signal, code: result.error?.code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function success(args, label) {
  const result = invoke(args);
  assert.equal(result.code, null, `${label} could not start`); assert.equal(result.signal, null, `${label} terminated`);
  assert.equal(result.status, 0, `${label} failed: ${result.status} ${result.stderr.trim()}`);
  return result.stdout.trim();
}
function inventory() {
  const list = args => success(args, "Inventory").split(/\r?\n/).filter(Boolean).sort();
  return { images: list(["image", "ls", "--no-trunc", "--format", "{{.ID}}"]), containers: list(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]), volumes: list(["volume", "ls", "--quiet"]) };
}
try {
  before = inventory();
  const inspectedImage = JSON.parse(success(["image", "inspect", image], "Image inspect"))[0];
  assert.equal(inspectedImage.Id, "sha256:7da46787f876ed2bca2214cad59c44d1f1876f6639962390d653e3588b941c74");
  created = true;
  success(["create", "--name", name, "--pull", "never", "--network", "none", "--read-only", "--user", "65534:65534",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "1536m", "--cpus", "2", "--restart", "no",
    "--env", "HOME=/tmp/home", "--env", "CODEX_HOME=/tmp/codex-home", "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=268435456,mode=1777", "--entrypoint", "/usr/local/bin/node", image,
    "-e", "setInterval(() => {}, 1000)"], "Container create");
  const inspection = JSON.parse(success(["inspect", name], "Container inspect"))[0];
  assert.equal(inspection.HostConfig.NetworkMode, "none"); assert.equal(inspection.Config.User, "65534:65534");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true); assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.equal(inspection.Mounts.length, 0); report.configurationVerified = true;
  success(["start", name], "Container start");
  await new Promise(resolve => setTimeout(resolve, 300));
  const running = JSON.parse(success(["inspect", name], "Running inspection"))[0];
  assert.equal(running.State.Running, true, "Synthetic process exited before cutoff");
  success(["kill", name], "Synthetic cutoff");
  const stopped = JSON.parse(success(["inspect", name], "Stopped inspection"))[0];
  assert.equal(stopped.State.Running, false); report.stopped = true;
  success(["rm", "--force", "--volumes", name], "Container removal"); created = false;
  report.cleanup.removed = true;
  report.verified = true;
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  if (created) {
    const removed = invoke(["rm", "--force", "--volumes", name]);
    report.cleanup.emergencyRemoval = { status: removed.status, code: removed.code };
    if (removed.status !== 0) { report.verified = false; process.exitCode = 1; }
  }
  try { const after = inventory(); report.cleanup.inventory = Object.fromEntries(Object.keys(after).map(key => [key, JSON.stringify(before?.[key]) === JSON.stringify(after[key])]));
    if (Object.values(report.cleanup.inventory).some(value => !value)) { report.verified = false; process.exitCode = 1; }
  } catch (error) { report.cleanup.inventoryError = error.message; report.verified = false; process.exitCode = 1; }
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
