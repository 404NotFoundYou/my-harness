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
const output = path.join(itemDirectory, "container-isolation-result.json");
const temporaryRoot = await mkdtemp(path.join(await realpath(tmpdir()), "ai-harness-container-isolation-"));
const workspace = path.join(temporaryRoot, "workspace");
const codexHome = path.join(temporaryRoot, "codex-home");
const external = path.join(temporaryRoot, "external");
const hostMemory = path.join(temporaryRoot, "host-memory");
const containerName = `ai-harness-isolation-${randomUUID()}`;
const image = "postgres:18.6-alpine";
const expectedImage = "sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const digest = value => createHash("sha256").update(value).digest("hex");

function dockerCommand(args, { timeout = 30_000 } = {}) {
  const result = spawnSync(docker, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    args,
    exitCode: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function successful(result, label) {
  assert.equal(result.errorCode, null, `${label} could not start`);
  assert.equal(result.signal, null, `${label} was terminated by a signal`);
  assert.equal(result.exitCode, 0, `${label} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  actualModelCalls: 0,
  realMemoryPathsAccessed: 0,
  imagePulls: 0,
  packageInstalls: 0,
  image,
  expectedImage,
  docker: {},
  hostControls: {},
  container: {},
  cleanup: {},
  verified: false,
  boundary: "",
};

let created = false;
try {
  for (const directory of [workspace, path.join(codexHome, "memories"), external, hostMemory]) {
    await mkdir(directory, { recursive: true });
  }
  const fixtures = [
    [path.join(workspace, "inside.txt"), "workspace-canary"],
    [path.join(codexHome, "memories", "memory_summary.md"), "synthetic-memory-canary"],
    [path.join(external, "outside.txt"), "external-canary"],
    [path.join(hostMemory, "MEMORY.md"), "host-memory-canary"],
  ];
  for (const [file, contents] of fixtures) await writeFile(file, contents, "utf8");
  report.hostControls = Object.fromEntries(await Promise.all(fixtures.map(async ([file, contents]) => {
    const actual = await readFile(file, "utf8");
    assert.equal(actual, contents, "Host control fixture differs");
    return [path.basename(file), { exists: true, sha256: digest(actual) }];
  })));

  report.docker.serverVersion = successful(dockerCommand(["version", "--format", "{{.Server.Version}}"]), "Docker version");
  report.docker.imageId = successful(dockerCommand(["image", "inspect", image, "--format", "{{.Id}}"]), "Image inspection");
  assert.equal(report.docker.imageId, expectedImage, "Existing image identity changed");
  const imagesBefore = successful(dockerCommand(["image", "ls", "--no-trunc", "--format", "{{.ID}}"]), "Image inventory before").split(/\r?\n/).filter(Boolean).sort();
  const containersBefore = successful(dockerCommand(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]), "Container inventory before").split(/\r?\n/).filter(Boolean).sort();
  const volumesBefore = successful(dockerCommand(["volume", "ls", "--quiet"]), "Volume inventory before").split(/\r?\n/).filter(Boolean).sort();

  const shellProbe = [
    "set -eu",
    "workspace_readable=false",
    "memory_readable=false",
    "external_denied=false",
    "host_memory_denied=false",
    "workspace_read_only=false",
    "memory_read_only=false",
    "root_read_only=false",
    "[ \"$(cat /probe/workspace/inside.txt)\" = workspace-canary ] && workspace_readable=true",
    "[ \"$(cat /probe/codex-home/memories/memory_summary.md)\" = synthetic-memory-canary ] && memory_readable=true",
    "[ ! -r /probe/external/outside.txt ] && external_denied=true",
    "[ ! -r /probe/host-memory/MEMORY.md ] && host_memory_denied=true",
    "if printf x > /probe/workspace/new.txt 2>/dev/null; then :; else workspace_read_only=true; fi",
    "if printf x > /probe/codex-home/new.txt 2>/dev/null; then :; else memory_read_only=true; fi",
    "if printf x > /probe-root-write 2>/dev/null; then :; else root_read_only=true; fi",
    "printf 'PROBE_RESULT={\"workspaceReadable\":%s,\"syntheticMemoryReadable\":%s,\"externalDenied\":%s,\"hostMemoryDenied\":%s,\"workspaceReadOnly\":%s,\"syntheticMemoryReadOnly\":%s,\"rootReadOnly\":%s}\\n' \"$workspace_readable\" \"$memory_readable\" \"$external_denied\" \"$host_memory_denied\" \"$workspace_read_only\" \"$memory_read_only\" \"$root_read_only\"",
  ].join("\n");
  const createArgs = [
    "create",
    "--name", containerName,
    "--pull", "never",
    "--network", "none",
    "--read-only",
    "--user", "65534:65534",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "32",
    "--memory", "64m",
    "--cpus", "0.5",
    "--restart", "no",
    "--mount", `type=bind,src=${workspace},dst=/probe/workspace,readonly`,
    "--mount", `type=bind,src=${codexHome},dst=/probe/codex-home,readonly`,
    "--mount", "type=tmpfs,dst=/var/lib/postgresql,tmpfs-size=1048576,tmpfs-mode=0700",
    "--entrypoint", "/bin/sh",
    image,
    "-c", shellProbe,
  ];
  const containerId = successful(dockerCommand(createArgs), "Container creation");
  created = true;
  report.container.idSha256 = digest(containerId);
  report.container.createArgs = createArgs.map(value => value.includes(temporaryRoot) ? value.replaceAll(temporaryRoot, "<temporary-root>") : value);

  const inspection = JSON.parse(successful(dockerCommand(["inspect", containerName]), "Container inspection"))[0];
  const mounts = inspection.Mounts.map(mount => ({
    type: mount.Type,
    destination: mount.Destination,
    readWrite: mount.RW,
    sourceSha256: digest(mount.Source),
  })).sort((left, right) => left.destination.localeCompare(right.destination));
  const bindMounts = mounts.filter(mount => mount.type === "bind");
  assert.deepEqual(bindMounts.map(({ type, destination, readWrite }) => ({ type, destination, readWrite })), [
    { type: "bind", destination: "/probe/codex-home", readWrite: false },
    { type: "bind", destination: "/probe/workspace", readWrite: false },
  ]);
  assert.equal(mounts.some(mount => mount.type === "volume"), false, "Image volume must not create a host-backed anonymous volume");
  assert.ok(mounts.every(mount => ["bind", "tmpfs"].includes(mount.type)), "Only bind and tmpfs mounts are permitted");
  assert.ok(mounts.some(mount => mount.type === "tmpfs" && mount.destination === "/var/lib/postgresql"), "Image volume destination must be shadowed by tmpfs");
  assert.equal(inspection.HostConfig.NetworkMode, "none");
  assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(inspection.HostConfig.CapDrop, ["ALL"]);
  assert.ok(inspection.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(inspection.Config.User, "65534:65534");
  report.container.configuration = {
    image: inspection.Image,
    networkMode: inspection.HostConfig.NetworkMode,
    readOnlyRoot: inspection.HostConfig.ReadonlyRootfs,
    user: inspection.Config.User,
    capDrop: inspection.HostConfig.CapDrop,
    securityOptions: inspection.HostConfig.SecurityOpt,
    mounts,
  };

  const started = dockerCommand(["start", "--attach", containerName]);
  assert.equal(started.errorCode, null, "Container probe could not start");
  assert.equal(started.signal, null, "Container probe was terminated by a signal");
  assert.equal(started.exitCode, 0, `Container probe failed: ${started.stderr.trim()}`);
  const resultLine = started.stdout.split(/\r?\n/).find(line => line.startsWith("PROBE_RESULT="));
  assert.ok(resultLine, "Container did not emit a probe result");
  report.container.result = JSON.parse(resultLine.slice("PROBE_RESULT=".length));
  assert.deepEqual(report.container.result, {
    workspaceReadable: true,
    syntheticMemoryReadable: true,
    externalDenied: true,
    hostMemoryDenied: true,
    workspaceReadOnly: true,
    syntheticMemoryReadOnly: true,
    rootReadOnly: true,
  });
  report.container.stderrBytes = Buffer.byteLength(started.stderr);

  successful(dockerCommand(["rm", "--volumes", containerName]), "Container removal");
  created = false;
  const imagesAfter = successful(dockerCommand(["image", "ls", "--no-trunc", "--format", "{{.ID}}"]), "Image inventory after").split(/\r?\n/).filter(Boolean).sort();
  const containersAfter = successful(dockerCommand(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]), "Container inventory after").split(/\r?\n/).filter(Boolean).sort();
  const volumesAfter = successful(dockerCommand(["volume", "ls", "--quiet"]), "Volume inventory after").split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(imagesAfter, imagesBefore, "Image inventory changed during a no-pull probe");
  assert.deepEqual(containersAfter, containersBefore, "Container inventory was not restored");
  assert.deepEqual(volumesAfter, volumesBefore, "Volume inventory was not restored");
  report.cleanup = { containerRemoved: true, imageInventoryUnchanged: true, containerInventoryRestored: true, volumeInventoryRestored: true };
  report.verified = true;
  report.boundary = "Verified Docker bind-mount isolation for the existing postgres Alpine image only. This did not run Codex or Node inside the container, access any real memory path, test Windows sandbox ACLs, or attest external MCP/tool executors.";
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  if (created) {
    const removal = dockerCommand(["rm", "--force", "--volumes", containerName]);
    report.cleanup.emergencyRemoval = { exitCode: removal.exitCode, errorCode: removal.errorCode };
  }
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  assert.equal(path.dirname(temporaryRoot), await realpath(tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith("ai-harness-container-isolation-"));
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(JSON.stringify(report, null, 2));
