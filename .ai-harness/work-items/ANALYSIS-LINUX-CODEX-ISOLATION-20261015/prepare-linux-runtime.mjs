import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";

const docker = process.argv[2];
assert.ok(path.isAbsolute(docker), "Explicit Docker CLI path is required");
const itemDirectory = path.dirname(fileURLToPath(import.meta.url));
const cacheRoot = path.join(await realpath(tmpdir()), "ai-harness-linux-codex-20261015");
assert.equal(path.basename(cacheRoot), "ai-harness-linux-codex-20261015");
await mkdir(cacheRoot, { recursive: true });

const nodeImage = {
  tag: "docker.io/library/node:22.20.0-bookworm-slim",
  indexDigest: "sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e",
  linuxAmd64Digest: "sha256:c385ec44d77c785e2364ac0c9b150809a0fdc17fde3dbf061e3dad07242c6a85",
};
nodeImage.reference = `docker.io/library/node@${nodeImage.linuxAmd64Digest}`;

const packages = [
  {
    role: "wrapper",
    name: "@openai/codex",
    version: "0.156.0",
    filename: "openai-codex-0.156.0.tgz",
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.156.0.tgz",
    integrity: "sha512-47dfpl2e8F47baSQTE+QaWzF/kKoOeR9YQ2fIBdRGzZZP2/QZ6D0uwLY2ZamS8ypov4UFtg92jZh8m+w65bsGg==",
    shasum: "e7c29bfd4e94973af2ea116c98a1f8f7b387e53b",
  },
  {
    role: "linux-x64",
    name: "@openai/codex",
    version: "0.156.0-linux-x64",
    filename: "openai-codex-0.156.0-linux-x64.tgz",
    url: "https://registry.npmjs.org/@openai/codex/-/codex-0.156.0-linux-x64.tgz",
    integrity: "sha512-/PX399ISB715skgBBOtOX5aqLxmPQhYC7wDasZnAJhRrtzt3qgs6kjSnimN9T8OFKv4LDAp+uJdN896tQYaTrA==",
    shasum: "d5df296ed9e3b029017b77ad3dcde683aaeb1e28",
  },
];

const digest = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
function dockerCommand(args, timeout = 300_000) {
  const result = spawnSync(docker, args, { encoding: "utf8", shell: false, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, `Docker could not start: ${args.join(" ")}`);
  assert.equal(result.signal, null, `Docker was terminated: ${args.join(" ")}`);
  assert.equal(result.status, 0, `Docker failed: ${result.stderr}`);
  return result.stdout.trim();
}
const inventory = type => dockerCommand(type === "volume" ? ["volume", "ls", "--quiet"] : [type, "ls", "--quiet", "--no-trunc"]).split(/\r?\n/).filter(Boolean).sort();
const inventoryRecord = values => ({ count: values.length, sha256: digest("sha256", values.join("\n")) });

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  nodeImage,
  packageDownloads: [],
  dockerBefore: {
    images: inventoryRecord(inventory("image")),
    containers: inventoryRecord(inventory("container")),
    volumes: inventoryRecord(inventory("volume")),
  },
  prepared: false,
};

for (const spec of packages) {
  const metadataResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(spec.name)}/${spec.version}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(metadataResponse.ok, true, `Package metadata unavailable: ${spec.version}`);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.name, spec.name);
  assert.equal(metadata.version, spec.version);
  assert.equal(metadata.dist.integrity, spec.integrity);
  assert.equal(metadata.dist.shasum, spec.shasum);
  assert.equal(metadata.dist.tarball, spec.url);
  const file = path.join(cacheRoot, spec.filename);
  let bytes;
  try { bytes = await readFile(file); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(300_000) });
    assert.equal(response.ok, true, `Package download failed: ${spec.version}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(file, bytes);
  }
  assert.equal(`sha512-${digest("sha512", bytes, "base64")}`, spec.integrity, `Integrity mismatch: ${spec.version}`);
  assert.equal(digest("sha1", bytes), spec.shasum, `Shasum mismatch: ${spec.version}`);
  report.packageDownloads.push({ ...spec, size: bytes.length, sha256: digest("sha256", bytes) });
}

report.pull = {
  args: ["pull", "--platform", "linux/amd64", nodeImage.reference],
  stdoutSha256: digest("sha256", dockerCommand(["pull", "--platform", "linux/amd64", nodeImage.reference], 600_000)),
};
const imageInspection = JSON.parse(dockerCommand(["image", "inspect", nodeImage.reference]))[0];
report.imageInspection = {
  id: imageInspection.Id,
  architecture: imageInspection.Architecture,
  os: imageInspection.Os,
  repoDigests: imageInspection.RepoDigests,
  nodeVersion: imageInspection.Config.Env.find(value => value.startsWith("NODE_VERSION=")) ?? null,
};
assert.equal(report.imageInspection.architecture, "amd64");
assert.equal(report.imageInspection.os, "linux");
assert.ok(report.imageInspection.repoDigests.some(value => value.endsWith(`@${nodeImage.indexDigest}`) || value.endsWith(`@${nodeImage.linuxAmd64Digest}`)));
report.dockerAfter = {
  images: inventoryRecord(inventory("image")),
  containers: inventoryRecord(inventory("container")),
  volumes: inventoryRecord(inventory("volume")),
};
assert.deepEqual(report.dockerAfter.containers, report.dockerBefore.containers);
assert.deepEqual(report.dockerAfter.volumes, report.dockerBefore.volumes);
report.prepared = true;
report.boundary = "Downloaded two public npm tarballs with registry integrity verification and pulled one pinned linux/amd64 Node image. No package was installed on the host and no model session ran.";
await writeFile(path.join(itemDirectory, "runtime-preparation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
