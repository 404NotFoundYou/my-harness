import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";

const docker = process.argv[2];
assert.ok(path.isAbsolute(docker), "Explicit Docker CLI path required");
const item = path.dirname(fileURLToPath(import.meta.url));
const reportPath = path.join(item, "image-preparation.json");
const temporary = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), "ai-harness-codex-image-")));
const context = path.join(temporary, "context"), dockerConfig = path.join(temporary, "docker-config");
const endpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
const base = "docker.io/library/node@sha256:c385ec44d77c785e2364ac0c9b150809a0fdc17fde3dbf061e3dad07242c6a85";
const baseId = "sha256:c385ec44d77c785e2364ac0c9b150809a0fdc17fde3dbf061e3dad07242c6a85";
const tag = "ai-harness/codex:0.156.0-node22.20.0";
const packages = [
  { role: "wrapper", version: "0.156.0", file: "wrapper.tgz", url: "https://registry.npmjs.org/@openai/codex/-/codex-0.156.0.tgz", integrity: "sha512-47dfpl2e8F47baSQTE+QaWzF/kKoOeR9YQ2fIBdRGzZZP2/QZ6D0uwLY2ZamS8ypov4UFtg92jZh8m+w65bsGg==", shasum: "e7c29bfd4e94973af2ea116c98a1f8f7b387e53b", sha256: "5ce491a5ba3c0c2489594dfb6807c7c0b51166882e080772659f06f0c1fdc5d6" },
  { role: "linux-x64", version: "0.156.0-linux-x64", file: "platform.tgz", url: "https://registry.npmjs.org/@openai/codex/-/codex-0.156.0-linux-x64.tgz", integrity: "sha512-/PX399ISB715skgBBOtOX5aqLxmPQhYC7wDasZnAJhRrtzt3qgs6kjSnimN9T8OFKv4LDAp+uJdN896tQYaTrA==", shasum: "d5df296ed9e3b029017b77ad3dcde683aaeb1e28", sha256: "e16d3ee5f51562cdb83a523ac5f2b8929fe4693c744e1484d478112f52e3a239" },
];
const digest = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), sourceCommit: "1826adc517954e4358cf4f9e1b24bc45507b6905",
  base, baseId, tag, packages: [], modelCalls: 0, credentialsInjected: false, dockerConfig: "empty temporary directory", buildNetwork: "none", prepared: false, cleanup: {} };
const dockerEnv = { ...process.env, DOCKER_CONFIG: dockerConfig, DOCKER_HOST: endpoint, DOCKER_CONTEXT: "" };

function command(args, timeout = 300000) {
  const result = spawnSync(docker, ["-H", endpoint, ...args], { encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: dockerEnv });
  assert.equal(result.error, undefined, `Docker launch failed: ${args[0]}`);
  assert.equal(result.signal, null, `Docker terminated: ${args[0]}`);
  assert.equal(result.status, 0, `Docker ${args[0]} failed: ${(result.stderr ?? "").replaceAll(temporary, "<temporary>")}`);
  return (result.stdout ?? "").trim();
}
function inventory(type) {
  const args = type === "volume" ? ["volume", "ls", "--quiet"] : [type, "ls", "--quiet", "--no-trunc"];
  return command(args).split(/\r?\n/).filter(Boolean).sort();
}
const summary = values => ({ count: values.length, sha256: digest("sha256", values.join("\n")) });

try {
  await mkdir(context); await mkdir(dockerConfig);
  report.dockerVersion = command(["version", "--format", "{{.Server.Version}}"]);
  assert.equal(report.dockerVersion, "29.4.3", "Docker server version changed; revalidate before build");
  const before = { images: inventory("image"), containers: inventory("container"), volumes: inventory("volume") };
  report.before = Object.fromEntries(Object.entries(before).map(([key, values]) => [key, summary(values)]));
  const existing = spawnSync(docker, ["-H", endpoint, "image", "inspect", tag], { encoding: "utf8", shell: false, windowsHide: true, env: dockerEnv });
  assert.equal(existing.error, undefined, "Docker image preflight failed to start");
  assert.notEqual(existing.status, 0, "Refusing to overwrite an existing runtime tag");
  for (const spec of packages) {
    const metadataResponse = await fetch(`https://registry.npmjs.org/%40openai%2Fcodex/${spec.version}`, { signal: AbortSignal.timeout(30000) });
    assert.equal(metadataResponse.ok, true, `Metadata failed: ${spec.role}`);
    const metadata = await metadataResponse.json();
    assert.equal(metadata.name, "@openai/codex"); assert.equal(metadata.version, spec.version);
    assert.equal(metadata.dist.integrity, spec.integrity); assert.equal(metadata.dist.shasum, spec.shasum); assert.equal(metadata.dist.tarball, spec.url);
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(300000) });
    assert.equal(response.ok, true, `Tarball failed: ${spec.role}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(`sha512-${digest("sha512", bytes, "base64")}`, spec.integrity);
    assert.equal(digest("sha1", bytes), spec.shasum);
    assert.equal(digest("sha256", bytes), spec.sha256);
    await writeFile(path.join(context, spec.file), bytes);
    report.packages.push({ role: spec.role, version: spec.version, bytes: bytes.length, integrity: spec.integrity, shasum: spec.shasum, sha256: spec.sha256 });
  }
  report.pull = { reference: base, resultSha256: digest("sha256", command(["pull", "--platform", "linux/amd64", base], 600000)) };
  const inspectedBase = JSON.parse(command(["image", "inspect", base]))[0];
  assert.equal(inspectedBase.Id, baseId); assert.equal(`${inspectedBase.Os}/${inspectedBase.Architecture}`, "linux/amd64");
  report.baseInspection = { id: inspectedBase.Id, repoDigests: inspectedBase.RepoDigests };
  const dockerfile = [
    `FROM ${base}`,
    "COPY wrapper.tgz /tmp/wrapper.tgz",
    "COPY platform.tgz /tmp/platform.tgz",
    "RUN mkdir -p /opt/codex/lib/node_modules/@openai/codex /opt/codex/lib/node_modules/@openai/codex-linux-x64 && \\",
    "    tar -xzf /tmp/wrapper.tgz -C /opt/codex/lib/node_modules/@openai/codex --strip-components=1 && \\",
    "    tar -xzf /tmp/platform.tgz -C /opt/codex/lib/node_modules/@openai/codex-linux-x64 --strip-components=1 && \\",
    "    rm /tmp/wrapper.tgz /tmp/platform.tgz && \\",
    "    /usr/local/bin/node /opt/codex/lib/node_modules/@openai/codex/bin/codex.js --version",
    "WORKDIR /workspace",
  ].join("\n") + "\n";
  await writeFile(path.join(context, "Dockerfile"), dockerfile);
  report.dockerfileSha256 = digest("sha256", dockerfile);
  const buildOutput = command(["buildx", "build", "--network", "none", "--platform", "linux/amd64", "--load", "--provenance=false", "--progress", "quiet", "-t", tag, context], 600000);
  report.buildOutputSha256 = digest("sha256", buildOutput);
  const image = JSON.parse(command(["image", "inspect", tag]))[0];
  assert.equal(`${image.Os}/${image.Architecture}`, "linux/amd64");
  report.image = { id: image.Id, repoDigests: image.RepoDigests, size: image.Size };
  const after = { images: inventory("image"), containers: inventory("container"), volumes: inventory("volume") };
  assert.deepEqual(after.containers, before.containers); assert.deepEqual(after.volumes, before.volumes);
  report.after = Object.fromEntries(Object.entries(after).map(([key, values]) => [key, summary(values)]));
  report.prepared = true;
} catch (error) {
  report.error = { code: error.code ?? null, message: String(error.message).replaceAll(temporary, "<temporary>") };
  process.exitCode = 1;
} finally {
  assert.equal(path.dirname(temporary), await realpath(tmpdir()));
  assert.ok(path.basename(temporary).startsWith("ai-harness-codex-image-"));
  await rm(temporary, { recursive: true, force: true });
  report.cleanup.temporaryBuildContextRemoved = true;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
