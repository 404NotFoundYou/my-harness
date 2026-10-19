import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";

const docker = process.argv[2];
assert.ok(path.isAbsolute(docker), "Explicit Docker CLI path required");
const image = "postgres:18.6-alpine";
const imageId = "sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";
const outputFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "writable-bind-result.json");
const temporary = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), "ai-harness-writable-bind-")));
const workspace = path.join(temporary, "workspace"), output = path.join(temporary, "output"), outside = path.join(temporary, "outside");
const name = `ai-harness-writable-bind-${randomUUID()}`;
const hash = value => createHash("sha256").update(value).digest("hex");
const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), commit: "1826adc517954e4358cf4f9e1b24bc45507b6905",
  image, imageId, actualModelCalls: 0, imagePulls: 0, packageInstalls: 0, credentialsPassed: false,
  container: {}, cleanup: {}, verified: false, boundary: "PostgreSQL Alpine image only; not a Codex/Node runtime or provider test." };
let cleanupArmed = false, before;

function invoke(args, timeout = 30000) {
  const result = spawnSync(docker, args, { encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, signal: result.signal, code: result.error?.code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function success(args, label, timeout) {
  const result = invoke(args, timeout);
  assert.equal(result.code, null, `${label}: launch failed`);
  assert.equal(result.signal, null, `${label}: terminated`);
  assert.equal(result.status, 0, `${label}: exit ${result.status}: ${result.stderr.replaceAll(temporary, "<temporary>").trim()}`);
  return result.stdout.trim();
}
function inventory() {
  return {
    images: success(["image", "ls", "--no-trunc", "--format", "{{.ID}}"], "Image inventory").split(/\r?\n/).filter(Boolean).sort(),
    containers: success(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"], "Container inventory").split(/\r?\n/).filter(Boolean).sort(),
    volumes: success(["volume", "ls", "--quiet"], "Volume inventory").split(/\r?\n/).filter(Boolean).sort(),
  };
}
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

try {
  for (const directory of [workspace, output, outside]) await mkdir(directory);
  await writeFile(path.join(workspace, "inside.txt"), "workspace-canary\n");
  await writeFile(path.join(output, "inside.txt"), "output-canary\n");
  await writeFile(path.join(outside, "private.txt"), "unmounted-canary\n");
  report.dockerVersion = success(["version", "--format", "{{.Server.Version}}"], "Docker version");
  const inspectedImage = JSON.parse(success(["image", "inspect", image], "Image inspection"))[0];
  assert.equal(inspectedImage.Id, imageId);
  assert.equal(`${inspectedImage.Os}/${inspectedImage.Architecture}`, "linux/amd64");
  assert.ok(Object.hasOwn(inspectedImage.Config.Volumes, "/var/lib/postgresql"));
  before = inventory();
  report.before = Object.fromEntries(Object.entries(before).map(([key, values]) => [key, { count: values.length, sha256: hash(values.join("\n")) }]));
  const shell = [
    "set -eu",
    "test \"$(id -u)\" = 65534 && test \"$(id -g)\" = 65534",
    "test \"$(cat /workspace/inside.txt)\" = workspace-canary",
    "test \"$(cat /output/inside.txt)\" = output-canary",
    "test ! -r /outside/private.txt",
    "printf 'workspace-write\\n' > /workspace/created.txt",
    "printf 'output-write\\n' > /output/created.txt",
    "printf 'tmpfs-write\\n' > /tmp/created.txt",
    "test \"$(cat /workspace/created.txt)\" = workspace-write",
    "test \"$(cat /output/created.txt)\" = output-write",
    "if printf x > /rootfs-probe 2>/dev/null; then exit 72; fi",
    "printf 'PROBE_RESULT={\"uid\":65534,\"gid\":65534,\"workspaceReadWrite\":true,\"outputReadWrite\":true,\"outsideDenied\":true,\"tmpfsWritable\":true,\"rootWriteDenied\":true}\\n'",
  ].join("\n");
  const args = ["create", "--name", name, "--interactive", "--pull", "never", "--network", "none", "--read-only", "--user", "65534:65534",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "1536m", "--cpus", "2", "--restart", "no",
    "--env", "HOME=/tmp/home", "--env", "CODEX_HOME=/tmp/codex-home", "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=268435456,mode=1777",
    "--mount", `type=bind,src=${workspace},dst=/workspace`, "--mount", `type=bind,src=${output},dst=/output`,
    "--mount", "type=tmpfs,dst=/var/lib/postgresql,tmpfs-size=1048576,tmpfs-mode=0700",
    "--entrypoint", "/bin/sh", image, "-c", shell];
  cleanupArmed = true;
  success(args, "Container create");
  const inspected = JSON.parse(success(["inspect", name], "Container inspect"))[0];
  assert.equal(inspected.Image, imageId);
  assert.equal(inspected.Config.User, "65534:65534"); assert.equal(inspected.Config.OpenStdin, true);
  const host = inspected.HostConfig;
  assert.equal(host.NetworkMode, "none"); assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false);
  assert.deepEqual(host.CapDrop, ["ALL"]); assert.ok(host.SecurityOpt.includes("no-new-privileges:true"));
  assert.equal(host.PidsLimit, 128); assert.equal(host.Memory, 1536 * 1024 * 1024); assert.equal(host.NanoCpus, 2_000_000_000);
  assert.deepEqual(host.RestartPolicy, { Name: "no", MaximumRetryCount: 0 }); assert.deepEqual(host.PortBindings ?? {}, {});
  assert.deepEqual(String(host.Tmpfs?.["/tmp"] ?? "").split(",").sort(), ["rw", "exec", "nosuid", "nodev", "size=268435456", "mode=1777"].sort());
  const mounts = inspected.Mounts.map(row => ({ type: row.Type, target: row.Destination, writable: row.RW, source: row.Source }));
  assert.equal(mounts.length, 3, "Expected two binds plus image-volume shadow");
  assert.ok(mounts.every(row => ["bind", "tmpfs"].includes(row.type)));
  for (const [target, source] of [["/workspace", workspace], ["/output", output]]) {
    const mount = mounts.find(row => row.target === target);
    assert.ok(mount && mount.type === "bind" && mount.writable && samePath(mount.source, source), `${target} bind differs`);
  }
  assert.ok(mounts.some(row => row.type === "tmpfs" && row.target === "/var/lib/postgresql"));
  report.container.configuration = { image: inspected.Image, user: inspected.Config.User, network: host.NetworkMode, readOnlyRoot: host.ReadonlyRootfs,
    privileged: host.Privileged, capDrop: host.CapDrop, noNewPrivileges: true, pids: host.PidsLimit, memoryBytes: host.Memory,
    nanoCpus: host.NanoCpus, restart: host.RestartPolicy, mounts: mounts.map(({ type, target, writable }) => ({ type, target, writable })) };
  const started = success(["start", "--attach", name], "Container start", 30000);
  const line = started.split(/\r?\n/).find(value => value.startsWith("PROBE_RESULT="));
  assert.ok(line, "Container result missing");
  report.container.result = JSON.parse(line.slice("PROBE_RESULT=".length));
  assert.deepEqual(report.container.result, { uid: 65534, gid: 65534, workspaceReadWrite: true, outputReadWrite: true, outsideDenied: true, tmpfsWritable: true, rootWriteDenied: true });
  assert.equal(await readFile(path.join(workspace, "created.txt"), "utf8"), "workspace-write\n");
  assert.equal(await readFile(path.join(output, "created.txt"), "utf8"), "output-write\n");
  report.hostWrites = { workspaceSha256: hash(await readFile(path.join(workspace, "created.txt"))), outputSha256: hash(await readFile(path.join(output, "created.txt"))) };
  report.verified = true;
} catch (error) {
  report.error = { code: error.code ?? null, message: String(error.message).replaceAll(temporary, "<temporary>") };
  process.exitCode = 1;
} finally {
  if (cleanupArmed) {
    const removed = invoke(["rm", "--force", "--volumes", name]);
    report.cleanup.removal = { status: removed.status, signal: removed.signal, code: removed.code };
    if (removed.status !== 0 || removed.code !== null || removed.signal !== null) { report.verified = false; process.exitCode = 1; }
  }
  try {
    const after = inventory();
    report.cleanup.inventory = Object.fromEntries(Object.keys(after).map(key => [key, JSON.stringify(after[key]) === JSON.stringify(before?.[key])]));
    if (Object.values(report.cleanup.inventory).some(value => !value)) { report.verified = false; process.exitCode = 1; }
  } catch (error) { report.cleanup.inventoryError = error.message; report.verified = false; process.exitCode = 1; }
  assert.equal(path.dirname(temporary), await realpath(tmpdir()));
  assert.ok(path.basename(temporary).startsWith("ai-harness-writable-bind-"));
  await rm(temporary, { recursive: true, force: true });
  report.cleanup.fixturesRemoved = true;
  await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
