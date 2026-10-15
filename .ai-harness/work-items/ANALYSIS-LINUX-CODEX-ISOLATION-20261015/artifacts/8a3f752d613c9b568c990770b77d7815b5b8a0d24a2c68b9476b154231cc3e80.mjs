import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";

const docker = process.argv[2];
assert.ok(path.isAbsolute(docker), "Explicit Docker CLI path is required");
const itemDirectory = path.dirname(fileURLToPath(import.meta.url));
const innerScript = path.join(itemDirectory, "linux-runtime-inner.mjs");
const cacheRoot = path.join(await realpath(tmpdir()), "ai-harness-linux-codex-20261015");
const temporaryRoot = await mkdtemp(path.join(await realpath(tmpdir()), "ai-harness-linux-codex-fixtures-"));
const workspace = path.join(temporaryRoot, "workspace");
const external = path.join(temporaryRoot, "external");
const hostMemory = path.join(temporaryRoot, "host-memory");
const containerName = `ai-harness-linux-codex-${randomUUID()}`;
const image = "docker.io/library/node@sha256:c385ec44d77c785e2364ac0c9b150809a0fdc17fde3dbf061e3dad07242c6a85";
const digest = value => createHash("sha256").update(value).digest("hex");

function dockerCommand(args, timeout = 300_000) {
  const result = spawnSync(docker, args, { encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 });
  return { args, exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function successful(result, label) {
  assert.equal(result.errorCode, null, `${label} could not start`);
  assert.equal(result.signal, null, `${label} was terminated by a signal`);
  assert.equal(result.exitCode, 0, `${label} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function inventory(type) {
  const args = type === "volume" ? ["volume", "ls", "--quiet"] : [type, "ls", "--quiet", "--no-trunc"];
  return successful(dockerCommand(args), `${type} inventory`).split(/\r?\n/).filter(Boolean).sort();
}
const inventoryRecord = values => ({ count: values.length, sha256: digest(values.join("\n")) });

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  image,
  actualModelCalls: 0,
  realMemoryPathsAccessed: 0,
  hostControls: {},
  container: {},
  cleanup: {},
  verified: false,
  boundary: "",
};
let created = false;
try {
  await Promise.all([mkdir(workspace), mkdir(external), mkdir(hostMemory)]);
  const fixtures = [
    [path.join(workspace, "inside.txt"), "inside-canary"],
    [path.join(external, "outside.txt"), "outside-canary"],
    [path.join(hostMemory, "MEMORY.md"), "memory-canary"],
  ];
  for (const [file, contents] of fixtures) await writeFile(file, contents);
  report.hostControls = Object.fromEntries(await Promise.all(fixtures.map(async ([file, expected]) => {
    const actual = await readFile(file, "utf8");
    assert.equal(actual, expected);
    return [path.basename(file), { exists: true, sha256: digest(actual) }];
  })));
  const packages = (await Promise.all(["openai-codex-0.156.0.tgz", "openai-codex-0.156.0-linux-x64.tgz"].map(async name => ({ name, sha256: digest(await readFile(path.join(cacheRoot, name))) }))));
  assert.deepEqual(packages, [
    { name: "openai-codex-0.156.0.tgz", sha256: "5ce491a5ba3c0c2489594dfb6807c7c0b51166882e080772659f06f0c1fdc5d6" },
    { name: "openai-codex-0.156.0-linux-x64.tgz", sha256: "e16d3ee5f51562cdb83a523ac5f2b8929fe4693c744e1484d478112f52e3a239" },
  ]);
  report.packageInputs = packages;
  const before = { images: inventory("image"), containers: inventory("container"), volumes: inventory("volume") };
  report.dockerBefore = Object.fromEntries(Object.entries(before).map(([key, values]) => [key, inventoryRecord(values)]));

  const createArgs = [
    "create", "--name", containerName,
    "--pull", "never", "--network", "none", "--read-only",
    "--user", "65534:65534", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "128", "--memory", "1536m", "--cpus", "2", "--restart", "no",
    "--env", "HOME=/tmp/home", "--env", "CODEX_HOME=/tmp/codex-home", "--env", "PATH=/opt/runtime/bin:/usr/local/bin:/usr/bin:/bin",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777",
    "--tmpfs", "/opt/runtime:rw,exec,nosuid,nodev,size=512m,mode=0777",
    "--mount", `type=bind,src=${cacheRoot},dst=/packages,readonly`,
    "--mount", `type=bind,src=${innerScript},dst=/probe/linux-runtime-inner.mjs,readonly`,
    "--mount", `type=bind,src=${workspace},dst=/probe/workspace,readonly`,
    "--entrypoint", "/usr/local/bin/node", image, "/probe/linux-runtime-inner.mjs",
  ];
  const containerId = successful(dockerCommand(createArgs), "Container creation");
  created = true;
  report.container.idSha256 = digest(containerId);
  report.container.createArgs = createArgs.map(value => value.includes(cacheRoot) ? value.replaceAll(cacheRoot, "<temporary-package-cache>") : value.includes(temporaryRoot) ? value.replaceAll(temporaryRoot, "<temporary-fixtures>") : value.includes(itemDirectory) ? value.replaceAll(itemDirectory, "<analysis-item>") : value);
  const inspection = JSON.parse(successful(dockerCommand(["inspect", containerName]), "Container inspection"))[0];
  const mounts = inspection.Mounts.map(mount => ({ type: mount.Type, destination: mount.Destination, readWrite: mount.RW, sourceSha256: digest(mount.Source) })).sort((left, right) => left.destination.localeCompare(right.destination));
  assert.deepEqual(mounts.filter(mount => mount.type === "bind").map(({ destination, readWrite }) => ({ destination, readWrite })), [
    { destination: "/packages", readWrite: false },
    { destination: "/probe/linux-runtime-inner.mjs", readWrite: false },
    { destination: "/probe/workspace", readWrite: false },
  ]);
  assert.equal(mounts.some(mount => mount.type === "volume"), false);
  assert.ok(mounts.every(mount => ["bind", "tmpfs"].includes(mount.type)));
  assert.equal(inspection.HostConfig.NetworkMode, "none");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspection.Config.User, "65534:65534");
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspection.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  report.container.configuration = { image: inspection.Image, networkMode: inspection.HostConfig.NetworkMode, readOnlyRoot: inspection.HostConfig.ReadonlyRootfs, user: inspection.Config.User, capDrop: inspection.HostConfig.CapDrop, securityOptions: inspection.HostConfig.SecurityOpt, mounts };

  const started = dockerCommand(["start", "--attach", containerName], 300_000);
  const resultLine = started.stdout.split(/\r?\n/).find(line => line.startsWith("RUNTIME_PROBE_RESULT="));
  if (resultLine) report.runtime = JSON.parse(resultLine.slice("RUNTIME_PROBE_RESULT=".length));
  assert.equal(started.errorCode, null, "Runtime probe could not start");
  assert.equal(started.signal, null, "Runtime probe was terminated by a signal");
  assert.equal(started.exitCode, 0, `Runtime probe failed: ${started.stderr}`);
  assert.ok(resultLine, "Runtime probe did not emit a result");
  assert.equal(report.runtime.verified, true);
  assert.equal(report.runtime.actualModelCalls, 0);
  assert.equal(report.runtime.simulatedCliSessions, 3);
  assert.equal(report.runtime.localProviderRequests, 4);
  assert.deepEqual(report.runtime.memoryRows.map(row => [row.disabled, row.request.memoryMarkerPresent]), [[false, true], [true, false]]);
  assert.deepEqual(report.runtime.tool.result, [
    { readable: true, matches: true },
    { readable: false, code: "ENOENT" },
    { readable: false, code: "ENOENT" },
  ]);
  report.container.stderrBytes = Buffer.byteLength(started.stderr);
  successful(dockerCommand(["rm", "--volumes", containerName]), "Container removal");
  created = false;
  const after = { images: inventory("image"), containers: inventory("container"), volumes: inventory("volume") };
  assert.deepEqual(after, before);
  report.cleanup = { containerRemoved: true, imageInventoryUnchanged: true, containerInventoryRestored: true, volumeInventoryRestored: true, temporaryFixturesRemoved: false };
  report.verified = true;
  report.boundary = "Outer Docker isolation and real Linux Codex memory/exec_command behavior verified with a loopback responder. The exec_command session bypassed the inner Codex sandbox; default nested bwrap failed separately. External MCP and real provider behavior remain unverified.";
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  if (created) {
    const removal = dockerCommand(["rm", "--force", "--volumes", containerName]);
    report.cleanup.emergencyRemoval = { exitCode: removal.exitCode, errorCode: removal.errorCode };
  }
  assert.equal(path.dirname(temporaryRoot), await realpath(tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("ai-harness-linux-codex-fixtures-"));
  await rm(temporaryRoot, { recursive: true, force: true });
  report.cleanup.temporaryFixturesRemoved = true;
  await writeFile(path.join(itemDirectory, "linux-runtime-result.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
