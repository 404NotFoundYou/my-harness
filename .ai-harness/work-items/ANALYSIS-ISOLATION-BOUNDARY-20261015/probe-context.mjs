import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const cli = process.argv[2];
assert.ok(cli && /\.m?js$/i.test(cli), "Explicit Node CLI entry is required");
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), "prompt-diagnostic.json");
const root = await mkdtemp(path.join(await realpath(tmpdir()), "ai-harness-context-diagnostic-"));
const home = path.join(root, "home"), workspace = path.join(root, "workspace");
const sha = value => createHash("sha256").update(value).digest("hex");
const contextMarker = "CONTEXT_" + randomUUID(), memoryMarker = "MEMORY_" + randomUUID();
const report = { recordedAt: new Date().toISOString(), actualModelSessions: 0, platform: process.platform, node: process.version, cliEntrySha256: sha(await readFile(cli)), rows: [], diagnosticPassed: false, memoryInjectionVerified: false, filesystemIsolationVerified: false };
const env = { ...process.env, CODEX_HOME: home };
function query(args) {
  assert.ok(["--version", "features", "debug"].includes(args[0]), "No model or sandbox command is allowed");
  if (args[0] === "debug") assert.ok(["models", "prompt-input"].includes(args[1]), "Only offline debug endpoints are allowed");
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env, shell: false, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, "Offline diagnostic process failed");
  assert.equal(result.status, 0, "Offline diagnostic command did not succeed");
  return result.stdout;
}
try {
  await mkdir(home); await mkdir(workspace);
  for (const directory of ["memories", "memories_v2"]) {
    await mkdir(path.join(home, directory));
    for (const name of ["memory_summary.md", "MEMORY.md"]) await writeFile(path.join(home, directory, name), memoryMarker + "\n");
  }
  const version = query(["--version"]).trim();
  assert.equal(version, "codex-cli 0.156.0", "Diagnostic is bound to the investigated CLI version"); report.cliVersion = version;
  const catalog = query(["debug", "models", "--bundled"]); JSON.parse(catalog);
  const catalogPath = path.join(root, "models.json"); await writeFile(catalogPath, catalog);
  for (const scenario of [
    { name: "v1-on", enabled: true, use: true, version: "v1", ordinaryMarker: false },
    { name: "v1-off", enabled: false, use: true, version: "v1", ordinaryMarker: false },
    { name: "v1-use-off", enabled: true, use: false, version: "v1", ordinaryMarker: false },
    { name: "v2-on", enabled: true, use: true, version: "v2", ordinaryMarker: false },
    { name: "ordinary-marker-control", enabled: false, use: true, version: "v1", ordinaryMarker: true },
  ]) {
    await writeFile(path.join(home, "AGENTS.md"), contextMarker + (scenario.ordinaryMarker ? "\n" + memoryMarker : "") + "\n");
    await writeFile(path.join(home, "config.toml"), 'model="gpt-6-astra"\nmodel_catalog_json=' + JSON.stringify(catalogPath) + '\n[features]\nmemories=' + scenario.enabled + '\n[memories]\nversion="' + scenario.version + '"\nuse_memories=' + scenario.use + '\ngenerate_memories=false\n');
    const features = query(["features", "list"]);
    const feature = /^memories\s+\S+\s+(true|false)\s*$/m.exec(features);
    assert.ok(feature, "Memory feature state must be observable"); assert.equal(feature[1] === "true", scenario.enabled);
    const raw = query(["debug", "prompt-input", "Offline synthetic diagnostic; no model turn"]);
    const text = JSON.stringify(JSON.parse(raw));
    const row = { ...scenario, featureEnabled: feature[1] === "true", contextMarkerPresent: text.includes(contextMarker), memoryMarkerPresent: text.includes(memoryMarker), promptSha256: sha(raw) };
    report.rows.push(row);
    assert.equal(row.contextMarkerPresent, true, "Ordinary instructions must reach the observed prompt");
    assert.equal(row.memoryMarkerPresent, scenario.ordinaryMarker, "Offline renderer omits memory extension context even when enabled; ordinary content is distinguishable");
  }
  report.diagnosticPassed = true;
  report.boundary = "Real CLI offline renderer with synthetic v1/v2 homes. No model turn, sandbox execution, permission change, or real memory body read. Passing this diagnostic does not establish memory injection or filesystem isolation.";
} catch (error) {
  report.error = { code: error.code || null, message: error.message }; process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  assert.equal(path.dirname(root), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith("ai-harness-context-diagnostic-"));
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
