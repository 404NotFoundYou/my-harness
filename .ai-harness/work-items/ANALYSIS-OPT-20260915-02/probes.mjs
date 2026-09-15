import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { installRuntime, initializeProject, uninstallRuntime } from "../../src/installer.mjs";
import { beginWorkItem } from "../../src/compact.mjs";
import { runRecordedCommand } from "../../src/evidence.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryParent = path.resolve(process.argv[2]);
await mkdir(temporaryParent, { recursive: true });
const root = await mkdtemp(path.join(temporaryParent, "probe-"));
const findings = [];
const digest = content => createHash("sha256").update(content).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(directory, args) {
  const result = spawnSync("git", args, { cwd: directory, shell: false, windowsHide: true, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
}

async function fixture(name, timeout = 5000) {
  const directory = path.join(root, name);
  await mkdir(directory);
  await installRuntime(sourceRoot, directory);
  await initializeProject(directory, { mode: "existing", docsMode: "existing" });
  const configFile = path.join(directory, ".ai-harness/config.json");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  config.commandTimeoutMs = timeout;
  await writeFile(configFile, JSON.stringify(config));
  git(directory, ["init"]);
  git(directory, ["config", "user.name", "Harness Probe"]);
  git(directory, ["config", "user.email", "probe@example.invalid"]);
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "fixture baseline"]);
  return directory;
}

const options = (id, verification, writeScopes) => ({ id, type: "ITERATION", title: "isolated probe", references: ["synthetic fixture"],
  acceptance: ["observe execution boundary"], authorizationMode: "autonomous", authorizationSource: "local probe only", risk: "low",
  approach: "inspect existing behavior", databaseEvidence: "no database", writeScopes, verification, docsImpact: ["N/A: fixture"] });

try {
  const windowsSource = path.join(root, "source-windows");
  git(root, ["clone", "--quiet", "--no-hardlinks", "--config", "core.autocrlf=true", sourceRoot, windowsSource]);
  const installed = path.join(root, "installed");
  await mkdir(installed);
  await installRuntime(windowsSource, installed);
  const before = await uninstallRuntime(windowsSource, installed, { dryRun: true });
  git(installed, ["init"]);
  git(installed, ["config", "user.name", "Harness Probe"]);
  git(installed, ["config", "user.email", "probe@example.invalid"]);
  git(installed, ["config", "core.autocrlf", "true"]);
  git(installed, ["add", "."]);
  git(installed, ["commit", "-m", "installed payload"]);
  const linuxCheckout = path.join(root, "checkout-lf");
  git(root, ["clone", "--quiet", "--no-hardlinks", "--config", "core.autocrlf=false", installed, linuxCheckout]);
  const after = await uninstallRuntime(windowsSource, linuxCheckout, { dryRun: true });
  const conflicts = after.operations.filter(operation => operation.action === "conflict");
  const first = conflicts[0];
  let lineEndingOnlyConflicts = 0;
  for (const conflict of conflicts) {
    const beforeContent = await readFile(path.join(installed, conflict.relative), "utf8");
    const afterContent = await readFile(path.join(linuxCheckout, conflict.relative), "utf8");
    if (beforeContent.replaceAll("\r\n", "\n") === afterContent.replaceAll("\r\n", "\n")) lineEndingOnlyConflicts++;
  }
  findings.push({ probe: "installation-receipt-checkout", beforeConflicts: before.operations.filter(operation => operation.action === "conflict").length,
    afterConflicts: conflicts.length, lineEndingOnlyConflicts, example: first?.relative,
    onlyLineEndingsInExample: first ? digest(Buffer.from((await readFile(path.join(installed, first.relative), "utf8")).replaceAll("\r\n", "\n"))) === digest(await readFile(path.join(linuxCheckout, first.relative))) : null });

  if (process.argv[3] !== "installation") {
  const timeoutRoot = await fixture("timeout", 600);
  await writeFile(path.join(timeoutRoot, "child.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync(".ai-harness/work-items/TIMEOUT/child-started.txt",String(process.pid)); setTimeout(()=>writeFileSync(".ai-harness/work-items/TIMEOUT/late.txt","late write"),1800);\n');
  await writeFile(path.join(timeoutRoot, "parent.test.mjs"), 'import { spawn } from "node:child_process"; spawn(process.execPath,["child.mjs"],{stdio:"ignore",windowsHide:true}); await new Promise(resolve=>setTimeout(resolve,4500));\n');
  await beginWorkItem(timeoutRoot, options("TIMEOUT", ["node --test parent.test.mjs"], ["parent.test.mjs", "child.mjs"]));
  const timed = await runRecordedCommand(timeoutRoot, { id: "TIMEOUT", taskId: "T1", checkId: "V1" });
  const returnedAt = Date.now();
  const marker = path.join(timeoutRoot, ".ai-harness/work-items/TIMEOUT/late.txt");
  const existedAtReturn = await stat(marker).then(() => true, () => false);
  await delay(5000); // 夹具后代自行结束，避免留下后台进程。
  const markerInfo = await stat(marker).catch(() => null);
  findings.push({ probe: "timeout-descendant", status: timed.status, timedOut: timed.command.timedOut, existedAtReturn,
    childStarted: await stat(path.join(timeoutRoot, ".ai-harness/work-items/TIMEOUT/child-started.txt")).then(() => true, () => false),
    wroteAfterReturn: Boolean(markerInfo && markerInfo.mtimeMs > returnedAt), markerExists: Boolean(markerInfo) });

  const outputRoot = await fixture("output");
  await writeFile(path.join(outputRoot, "loud.test.mjs"), 'process.stdout.write("x".repeat(2*1024*1024));\n');
  await beginWorkItem(outputRoot, options("OUTPUT", ["node --test loud.test.mjs"], ["loud.test.mjs"]));
  const recorded = await runRecordedCommand(outputRoot, { id: "OUTPUT", taskId: "T1", checkId: "V1" });
  const direct = spawnSync(process.execPath, ["--test", "loud.test.mjs"], { cwd: outputRoot, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  findings.push({ probe: "large-output", directExit: direct.status, recordedStatus: recorded.status, spawnError: recorded.command.spawnError,
    timedOut: recorded.command.timedOut, capturedBytes: recorded.command.stdout.bytes, previewTruncated: recorded.command.stdout.truncated });
  }
  console.log(JSON.stringify({ findings }, null, 2));
} finally {
  assert.equal(path.dirname(await realpath(root)), await realpath(temporaryParent));
  assert.ok(path.basename(root).startsWith("probe-"));
  await rm(root, { recursive: true, force: true });
}
