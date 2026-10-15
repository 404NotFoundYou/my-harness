import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { cliIdentity } from "./experiment.mjs";
import { codexMemoryArguments } from "./codex-environment.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || "") ? error.code : null;
function query(cli, args, { cwd, env = process.env } = {}) {
  assert.ok(["--version", "features", "debug", "sandbox"].includes(args[0]), "Preflight cannot execute a model session");
  const command = /\.m?js$/i.test(cli) ? process.execPath : cli;
  const launchArgs = command === process.execPath ? [cli, ...args] : args;
  const result = spawnSync(command, launchArgs, { cwd, env, shell: false, windowsHide: true, encoding: "utf8", timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, errorCode: safeCode(result.error), stdout: result.stdout || "", stderrBytes: Buffer.byteLength(result.stderr || "") };
}
function observed(result) { return { exitCode: result.status, errorCode: result.errorCode, stderrBytes: result.stderrBytes }; }
export function memoryPreflightReady(checks) {
  return checks.clientVersionKnown === true && checks.feature?.disabled === true && checks.prompt?.contextControl === true && checks.prompt?.memoryPositive === true && checks.prompt?.memoryNegative === true &&
    checks.filesystem?.controlReadable === true && checks.filesystem?.externalDenied === true && checks.filesystem?.memoryDenied === true &&
    checks.filesystem?.sandboxStateUnchanged === true && checks.environmentStable === true;
}
async function filesystemProbe(cli, workspace, external, home) {
  if (process.platform !== "win32") return { status: "unavailable", reason: "Windows sandbox probe only" };
  const stateFiles = ["setup_marker.json", "deny_read_acl_state.json"].map(file => path.join(home, ".sandbox", file));
  let before;
  try { before = await Promise.all(stateFiles.map(file => readFile(file))); }
  catch (error) { return { status: "unavailable", reason: "existing sandbox setup required", errorCode: safeCode(error) }; }
  let setup, deniedState;
  try { setup = JSON.parse(before[0]); deniedState = JSON.parse(before[1]); } catch { return { status: "unavailable", reason: "unrecognized sandbox setup state" }; }
  if (setup?.version !== 5 || !deniedState?.principals || typeof deniedState.principals !== "object" || Array.isArray(deniedState.principals)) return { status: "unavailable", reason: "unrecognized sandbox setup state" };
  if (Object.keys(deniedState.principals).length) return { status: "unavailable", reason: "existing denied-read state is active; no policy changes attempted" };
  const inside = path.join(workspace, "inside.txt"), outside = path.join(external, "outside.txt"), script = path.join(workspace, "access.mjs");
  await writeFile(inside, "inside-canary"); await writeFile(outside, "outside-canary");
  await writeFile(script, `import{readFile,open}from"node:fs/promises";const rows=[];for(const[file,expected]of[[process.argv[2],"inside-canary"],[process.argv[3],"outside-canary"]]){try{rows.push({readable:true,matches:await readFile(file,"utf8")===expected});}catch(error){rows.push({readable:false,code:error.code});}}try{const handle=await open(process.argv[4],"r");await handle.close();rows.push({readable:true,contentsRead:false});}catch(error){rows.push({readable:false,code:error.code,contentsRead:false});}console.log("MEMORY_ACCESS_RESULT="+JSON.stringify(rows));`);
  const leaf = [script, inside, outside, path.join(home, "memories", "MEMORY.md")];
  const host = spawnSync(process.execPath, leaf, { cwd: workspace, shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 });
  const profile = "benchmark_memory_check_" + randomUUID().replaceAll("-", "");
  const args = ["sandbox", ...codexMemoryArguments, "-P", profile, "-c", `permissions.${profile}.extends=":workspace"`, "-C", workspace, "--", process.execPath, ...leaf];
  const result = query(cli, args, { cwd: workspace });
  const parse = text => { const line = String(text || "").split(/\r?\n/).find(value => value.startsWith("MEMORY_ACCESS_RESULT=")); return line ? JSON.parse(line.slice("MEMORY_ACCESS_RESULT=".length)) : null; };
  const control = parse(host.stdout), checks = parse(result.stdout);
  const after = await Promise.all(stateFiles.map(file => readFile(file)));
  const denied = row => row?.readable === false && ["EACCES", "EPERM"].includes(row.code);
  return { status: result.status === 0 && checks ? "observed" : "unavailable", launch: { args, ...observed(result) }, hostControl: control, sandboxChecks: checks,
    controlReadable: host.status === 0 && control?.[0]?.matches === true && control?.[1]?.matches === true && checks?.[0]?.matches === true,
    externalDenied: control?.[1]?.matches === true && denied(checks?.[1]), memoryDenied: control?.[2]?.readable === true && denied(checks?.[2]),
    memoryContentsRead: false, sandboxStateUnchanged: before.every((bytes, index) => hash(bytes) === hash(after[index])),
    boundary: "Existing CLI sandbox helper and workspace profile; does not attest every external MCP execution tool" };
}
export async function preflightCodex({ cli, model, outputDirectory }) {
  assert.ok(typeof model === "string" && model.trim(), "Model must be explicit");
  await mkdir(outputDirectory); outputDirectory = await realpath(outputDirectory);
  const identity = await cliIdentity(cli, { codexEnvironment: true });
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "ai-harness-memory-preflight-")));
  const workspace = path.join(temporary, "workspace"), external = path.join(temporary, "external"), fakeHome = path.join(temporary, "codex-home");
  try {
    for (const directory of [workspace, external, path.join(fakeHome, "memories")]) await mkdir(directory, { recursive: true });
    const contextMarker = "CONTEXT_CANARY_" + randomUUID(), memoryMarker = "MEMORY_CANARY_" + randomUUID();
    await writeFile(path.join(workspace, "AGENTS.md"), "Offline context control: " + contextMarker + "\n");
    for (const name of ["memory_summary.md", "MEMORY.md"]) await writeFile(path.join(fakeHome, "memories", name), memoryMarker + "\n");
    const bundled = query(identity.entry, ["debug", "models", "--bundled"], { cwd: workspace });
    const catalogPath = path.join(temporary, "models.json");
    if (bundled.status !== 0) throw new Error("Bundled model catalog could not be read without inference");
    JSON.parse(bundled.stdout); await writeFile(catalogPath, bundled.stdout);
    await writeFile(path.join(fakeHome, "config.toml"), 'model=' + JSON.stringify(model) + '\nmodel_catalog_json=' + JSON.stringify(catalogPath) + '\n[features]\nmemories=true\n[memories]\nuse_memories=true\ngenerate_memories=false\n');
    const version = query(identity.entry, ["--version"], { cwd: workspace });
    const cliVersion = /^codex-cli ([0-9][0-9a-zA-Z.+-]*)\s*$/.exec(version.stdout)?.[1] ?? null;
    const feature = query(identity.entry, ["features", ...codexMemoryArguments, "list"], { cwd: workspace });
    const promptRows = [];
    for (const disabled of [false, true]) {
      const args = ["debug", ...(disabled ? codexMemoryArguments : []), "-c", "model=" + JSON.stringify(model), "-c", "model_catalog_json=" + JSON.stringify(catalogPath), "prompt-input", "Offline context probe; do not execute a model"];
      const result = query(identity.entry, args, { cwd: workspace, env: { ...process.env, CODEX_HOME: fakeHome } });
      let text = "";
      if (result.status === 0) text = JSON.stringify(JSON.parse(result.stdout));
      promptRows.push({ disabled, ...observed(result), contextMarkerPresent: text.includes(contextMarker), memoryMarkerPresent: text.includes(memoryMarker), promptSha256: result.status === 0 ? hash(result.stdout) : null });
    }
    const filesystem = await filesystemProbe(identity.entry, workspace, external, identity.environment.roots.home);
    const current = await cliIdentity(identity.entry, { codexEnvironment: true });
    const checks = { clientVersionKnown: cliVersion !== null, feature: { ...observed(feature), disabled: feature.status === 0 && /^memories\s+\S+\s+false\s*$/m.test(feature.stdout) },
      prompt: { rows: promptRows, contextControl: promptRows.every(row => row.exitCode === 0 && row.contextMarkerPresent),
        memoryPositive: promptRows[0].exitCode === 0 && promptRows[0].memoryMarkerPresent, memoryNegative: promptRows[1].exitCode === 0 && !promptRows[1].memoryMarkerPresent,
        boundary: "Synthetic CODEX_HOME and debug prompt renderer; absent markers in both rows do not prove memory isolation" }, filesystem,
      environmentStable: identity.sha256 === current.sha256 && identity.environment.sha256 === current.environment.sha256 };
    const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), actualModelSessions: 0, model, cliVersion, identity, checks, ready: memoryPreflightReady(checks),
      groups: ["weak-baseline", "weak-harness"].map(group => ({ group, memoryArguments: [...codexMemoryArguments], environmentSha256: identity.environment.sha256 })),
      scope: { fingerprinted: "selected user configuration, global instructions, skill/plugin manifests and directory/link identities",
        excluded: "auth, plugin assets, remote MCP data, arbitrary environment values, full actual exec toolchain" } };
    await writeFile(path.join(outputDirectory, "preflight.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    assert.equal(path.dirname(temporary), await realpath(tmpdir())); assert.ok(path.basename(temporary).startsWith("ai-harness-memory-preflight-"));
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index++) { const key = process.argv[index], value = process.argv[++index]; if (!["--cli", "--model", "--out"].includes(key) || !value || Object.hasOwn(options, key)) throw new Error("Invalid preflight arguments"); options[key] = value; }
    assert.ok(options["--cli"] && options["--model"] && options["--out"], "Explicit CLI, model and output directory are required");
    const result = await preflightCodex({ cli: options["--cli"], model: options["--model"], outputDirectory: options["--out"] });
    console.log(JSON.stringify({ ready: result.ready, actualModelSessions: 0, checks: result.checks }, null, 2)); process.exitCode = result.ready ? 0 : 2;
  } catch { console.error(JSON.stringify({ ready: false, actualModelSessions: 0, error: "Preflight could not be completed; no model session was executed" })); process.exitCode = 1; }
}
