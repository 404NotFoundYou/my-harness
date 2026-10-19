import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { loadContainerRuntime } from "../../../benchmarks/codex-container.mjs";

const docker = process.argv[2];
assert.ok(path.isAbsolute(docker), "Explicit Docker CLI path required");
const item = path.dirname(fileURLToPath(import.meta.url));
const manifest = path.join(item, "runtime.json"), reportFile = path.join(item, "runtime-verification.json");
const temporary = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), "ai-harness-codex-runtime-")));
const workspace = path.join(temporary, "workspace"), output = path.join(temporary, "output"), outside = path.join(temporary, "outside");
const probeName = `ai-harness-codex-write-${randomUUID()}`;
const digest = value => createHash("sha256").update(value).digest("hex");
const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), sourceCommit: "1826adc517954e4358cf4f9e1b24bc45507b6905",
  actualModelCalls: 0, credentialsInjected: false, providerRequests: 0, imagePulls: 0, runtime: {}, writeProbe: {}, cleanup: {}, verified: false,
  boundary: "Real pinned image identity, Docker adapter and synthetic bind writes only; no model/provider/MCP session." };
let launch = null, probeArmed = false, before;

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
  const list = args => success(args, "Inventory").split(/\r?\n/).filter(Boolean).sort();
  return { images: list(["image", "ls", "--no-trunc", "--format", "{{.ID}}"]), containers: list(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"]), volumes: list(["volume", "ls", "--quiet"]) };
}
const samePath = (left, right) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
function inspectMounts(name, image) {
  const row = JSON.parse(success(["inspect", name], "Container inspect"))[0], host = row.HostConfig;
  assert.equal(row.Image, image); assert.equal(row.Config.User, "65534:65534"); assert.equal(host.NetworkMode, "none");
  assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false); assert.deepEqual(host.CapDrop, ["ALL"]);
  assert.ok(host.SecurityOpt.includes("no-new-privileges:true")); assert.equal(host.PidsLimit, 128);
  assert.equal(host.Memory, 1536 * 1024 * 1024); assert.equal(host.NanoCpus, 2_000_000_000);
  assert.deepEqual(host.RestartPolicy, { Name: "no", MaximumRetryCount: 0 }); assert.deepEqual(host.PortBindings ?? {}, {});
  const mounts = row.Mounts.map(mount => ({ type: mount.Type, target: mount.Destination, writable: mount.RW, source: mount.Source }));
  assert.equal(mounts.length, 2); assert.ok(mounts.every(mount => mount.type === "bind"));
  for (const [target, source] of [["/workspace", workspace], ["/output", output]]) {
    const mount = mounts.find(entry => entry.target === target);
    assert.ok(mount?.writable && samePath(mount.source, source), `${target} bind differs`);
  }
  return { image: row.Image, user: row.Config.User, network: host.NetworkMode, readOnlyRoot: host.ReadonlyRootfs,
    privileged: host.Privileged, capDrop: host.CapDrop, pids: host.PidsLimit, memoryBytes: host.Memory, nanoCpus: host.NanoCpus,
    mounts: mounts.map(({ type, target, writable }) => ({ type, target, writable })) };
}

try {
  for (const directory of [workspace, output, outside]) await mkdir(directory);
  await writeFile(path.join(workspace, "inside.txt"), "workspace-canary\n");
  await writeFile(path.join(output, "inside.txt"), "output-canary\n");
  await writeFile(path.join(outside, "private.txt"), "unmounted-canary\n");
  before = inventory();
  report.before = Object.fromEntries(Object.entries(before).map(([key, values]) => [key, { count: values.length, sha256: digest(values.join("\n")) }]));
  const selected = await loadContainerRuntime(manifest, { docker });
  report.runtime.identity = selected.identity;
  assert.deepEqual(await selected.readIdentity(), selected.identity);
  launch = await selected.runtime.prepare({ root: workspace, outputDirectory: output, args: ["--version"] });
  assert.equal(launch.command, docker); assert.deepEqual(launch.args.slice(0, 3), ["start", "--attach", "--interactive"]);
  report.runtime.configuration = inspectMounts(launch.args.at(-1), selected.identity.imageId);
  assert.equal(success(launch.args, "Runtime CLI version"), "codex-cli 0.156.0");
  const clean = launch.cleanup(); launch = null;
  assert.equal(clean, null, `Runtime cleanup failed: ${clean}`);
  report.runtime.cliVersion = "codex-cli 0.156.0"; report.runtime.containerRemoved = true;

  const inline = [
    'const fs=require("node:fs");',
    'if(process.getuid()!==65534||process.getgid()!==65534)process.exit(71);',
    'if(fs.readFileSync("/workspace/inside.txt","utf8")!=="workspace-canary\\n")process.exit(72);',
    'if(fs.readFileSync("/output/inside.txt","utf8")!=="output-canary\\n")process.exit(73);',
    'fs.writeFileSync("/workspace/created.txt","workspace-write\\n");fs.writeFileSync("/output/created.txt","output-write\\n");',
    'let outsideDenied=false,rootWriteDenied=false;',
    'try{fs.readFileSync("/outside/private.txt");}catch(e){outsideDenied=e.code==="ENOENT";}',
    'try{fs.writeFileSync("/rootfs-probe","x");}catch(e){rootWriteDenied=["EACCES","EROFS"].includes(e.code);}',
    'console.log("PROBE_RESULT="+JSON.stringify({uid:process.getuid(),gid:process.getgid(),outsideDenied,rootWriteDenied}));',
  ].join("");
  const args = ["create", "--name", probeName, "--interactive", "--pull", "never", "--network", "none", "--read-only", "--user", "65534:65534",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "1536m", "--cpus", "2", "--restart", "no",
    "--env", "HOME=/tmp/home", "--env", "CODEX_HOME=/tmp/codex-home", "--env", "PATH=/usr/local/bin:/usr/bin:/bin",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=268435456,mode=1777",
    "--mount", `type=bind,src=${workspace},dst=/workspace`, "--mount", `type=bind,src=${output},dst=/output`,
    "--entrypoint", "/usr/local/bin/node", selected.identity.image, "-e", inline];
  probeArmed = true;
  success(args, "Write probe create");
  report.writeProbe.configuration = inspectMounts(probeName, selected.identity.imageId);
  const line = success(["start", "--attach", probeName], "Write probe start").split(/\r?\n/).find(row => row.startsWith("PROBE_RESULT="));
  assert.ok(line); report.writeProbe.result = JSON.parse(line.slice("PROBE_RESULT=".length));
  assert.deepEqual(report.writeProbe.result, { uid: 65534, gid: 65534, outsideDenied: true, rootWriteDenied: true });
  assert.equal(await readFile(path.join(workspace, "created.txt"), "utf8"), "workspace-write\n");
  assert.equal(await readFile(path.join(output, "created.txt"), "utf8"), "output-write\n");
  report.writeProbe.hostReadback = true;
  success(["rm", "--force", "--volumes", probeName], "Write probe cleanup"); probeArmed = false;
  report.verified = true;
} catch (error) {
  report.error = { code: error.code ?? null, message: String(error.message).replaceAll(temporary, "<temporary>") };
  process.exitCode = 1;
} finally {
  if (launch) { const error = launch.cleanup(); report.cleanup.runtimeError = error; if (error) { report.verified = false; process.exitCode = 1; } }
  if (probeArmed) { const result = invoke(["rm", "--force", "--volumes", probeName]); report.cleanup.probeRemoval = { status: result.status, code: result.code }; if (result.status !== 0) { report.verified = false; process.exitCode = 1; } }
  try { const after = inventory(); report.cleanup.inventory = Object.fromEntries(Object.keys(after).map(key => [key, JSON.stringify(after[key]) === JSON.stringify(before?.[key])]));
    if (Object.values(report.cleanup.inventory).some(value => !value)) { report.verified = false; process.exitCode = 1; }
  } catch (error) { report.cleanup.inventoryError = error.message; report.verified = false; process.exitCode = 1; }
  assert.equal(path.dirname(temporary), await realpath(tmpdir())); assert.ok(path.basename(temporary).startsWith("ai-harness-codex-runtime-"));
  await rm(temporary, { recursive: true, force: true }); report.cleanup.fixturesRemoved = true;
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
