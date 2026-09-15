import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { appendJsonLine, atomicWriteJson, readJson, resolveProjectPath, withFileLock, writeFileAtomic } from "./filesystem.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import { classifyCommand } from "./policy.mjs";
import { isValidCheckTimeoutMs, resolveCommandLaunch } from "./commands.mjs";
import { sourceSnapshot, saveSnapshot } from "./snapshot.mjs";
import { checksFor, invalidateResults, matchingChecks, planDigest } from "./verification.mjs";
import { loadConfig, loadPlan, loadWorkItem, workItemPaths } from "./workflow.mjs";

const decoder = new TextDecoder("utf-8", { fatal: false });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function redact(value) {
  return String(value)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\b(ghp|github_pat|sk|pk_live|AKIA)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\b((?:[A-Z][A-Z0-9_]*)?(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*(?:"([^"\\]*(?:\\[\s\S][^"\\]*)*)(?:"|\\?$)|'([^']*)(?:'|$)|([^\s"'\\]+))/g,
      (_match, key, quoted, single) => `${key}=${quoted !== undefined ? '"[REDACTED]"' : single !== undefined ? "'[REDACTED]'" : "[REDACTED]"}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

function capture(buffer, maxBytes, complete) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const redacted = Buffer.from(redact(decoder.decode(source)));
  const truncated = redacted.length > maxBytes;
  const head = Math.floor(maxBytes / 2);
  const visible = truncated ? Buffer.concat([redacted.subarray(0, head), Buffer.from("\n… output truncated …\n"), redacted.subarray(redacted.length - (maxBytes - head))]) : redacted;
  return {
    text: decoder.decode(visible),
    bytes: source.length,
    truncated,
    complete,
    sha256: sha256(source),
  };
}

function redactedArgs(args) {
  return args.map((arg) => redact(arg));
}

export async function runRecordedCommand(root, { id, taskId = null, command, args = [], checkId = null }) {
  const enteredAt = Date.now();
  root = await realpath(root);
  const item = await loadWorkItem(root, id);
  const plan = await loadPlan(root, id);
  let checkTimeoutMs;
  if (checkId) {
    const matches = plan.tasks.filter((task) => !taskId || task.id === taskId).flatMap((task) => checksFor(task).filter((check) => check.id === checkId));
    invariant(matches.length === 1, "CHECK_NOT_FOUND", "检查 ID 不存在或不唯一，请同时指定任务。" );
    ({ command, args, timeoutMs: checkTimeoutMs } = matches[0]);
  }
  invariant(item.status === "IMPLEMENTING" || item.status === "VERIFYING", "WRONG_STAGE", "受控命令只允许在 IMPLEMENTING 或 VERIFYING 阶段运行。" );
  invariant(typeof command === "string" && command.trim() && Array.isArray(args) && args.every((arg) => typeof arg === "string"), "INVALID_COMMAND", "命令和参数必须是字符串数组。" );
  invariant(item.status !== "IMPLEMENTING" || taskId, "TASK_REQUIRED", "IMPLEMENTING 阶段运行命令必须绑定任务。" );
  if (taskId) {
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    invariant(task, "TASK_NOT_FOUND", `任务不存在：${taskId}`);
    invariant(task.status === "IN_PROGRESS" || (item.status === "VERIFYING" && task.status === "COMPLETED"), "WRONG_TASK_STAGE", "受控命令需要实施中任务，或最终验证阶段已完成的任务。" );
  }
  const config = await loadConfig(root);
  invariant(checkTimeoutMs === undefined || isValidCheckTimeoutMs(checkTimeoutMs), "INVALID_CHECK_TIMEOUT", "检查 timeoutMs 必须是 1 到 1800000 之间的整数。" );
  const timeoutMs = checkTimeoutMs === undefined ? config.commandTimeoutMs : checkTimeoutMs;
  const outputLimitBytes = config.maxCommandOutputBytes === undefined ? 16 * 1024 * 1024 : config.maxCommandOutputBytes;
  invariant(Number.isInteger(outputLimitBytes) && outputLimitBytes > 0 && outputLimitBytes <= 64 * 1024 * 1024,
    "INVALID_COMMAND_OUTPUT_LIMIT", "maxCommandOutputBytes 必须是 1 到 67108864 之间的整数。" );
  const classification = classifyCommand(command, args, config);
  if (classification.decision !== "allow") {
    throw new HarnessError(
      classification.decision === "deny" ? "COMMAND_DENIED" : "COMMAND_REQUIRES_APPROVAL",
      classification.reason,
      classification,
    );
  }

  const paths = await workItemPaths(root, id);
  const before = await sourceSnapshot(root);
  const source = await saveSnapshot(root, paths.directory, before);
  const definition = planDigest(item, plan);
  const startedAt = Date.now();
  let launch = null;
  let result;
  try {
    launch = await resolveCommandLaunch(command, args);
    result = spawnSync(launch.command, launch.args, {
    cwd: root,
    encoding: null,
    shell: false,
    windowsHide: true,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    timeout: timeoutMs,
    maxBuffer: outputLimitBytes,
    });
  } catch (error) { result = { status: null, error, stdout: null, stderr: null }; }
  const endedAt = Date.now();
  const after = await sourceSnapshot(root);
  const sourceAfter = await saveSnapshot(root, paths.directory, after);
  const timedOut = result.error?.code === "ETIMEDOUT";
  const outputLimitExceeded = result.error?.code === "ENOBUFS";
  const complete = !result.error && !result.signal && typeof result.status === "number";
  const stdout = capture(result.stdout, config.maxCapturedOutputBytes, complete);
  const stderr = capture(result.stderr, config.maxCapturedOutputBytes, complete);
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const failureReason = timedOut ? "timeout" : outputLimitExceeded ? "output-limit" : result.error ? "spawn-error"
    : result.signal ? "signal" : exitCode !== 0 ? "exit-code" : before.digest !== after.digest ? "source-changed" : null;
  const event = {
    schemaVersion: 1,
    id: randomUUID(),
    workItemId: id,
    taskId,
    revision: item.revision || 1,
    taskAttempt: taskId ? plan.tasks.find((task) => task.id === taskId).attempt || 1 : null,
    kind: "command",
    status: failureReason === null ? "pass" : "fail",
    summary: `${redact(command)} ${redactedArgs(args).join(" ")}`.trim(),
    timestamp: new Date(startedAt).toISOString(),
    command: {
      executable: redact(command),
      args: redactedArgs(args),
      launch: launch ? { executable: redact(launch.command), args: redactedArgs(launch.args) } : null,
      checkIds: matchingChecks(plan, taskId, command, args, checkTimeoutMs),
      planDigest: definition,
      source,
      sourceAfter,
      cwd: ".",
      policy: classification,
      exitCode,
      signal: result.signal || null,
      timedOut,
      timeoutMs,
      ...(checkTimeoutMs === undefined ? {} : { checkTimeoutMs }),
      outputLimitBytes,
      outputLimitExceeded,
      failureReason,
      durationMs: endedAt - startedAt,
      stdout,
      stderr,
      spawnError: result.error ? redact(result.error.message) : null,
    },
  };
  for (const [name, captured, original] of [["stdout", stdout, result.stdout], ["stderr", stderr, result.stderr]]) {
    if (!captured.truncated) continue;
    const content = redact(decoder.decode(Buffer.isBuffer(original) ? original : Buffer.from(original || "")));
    const document = path.relative(root, path.join(paths.directory, "outputs", `${event.id}-${name}.txt`)).replaceAll("\\", "/");
    try {
      await writeFileAtomic(await resolveProjectPath(root, document, { forWrite: true }), content);
      captured.artifact = document;
      captured.artifactSha256 = sha256(content);
    } catch (error) {
      captured.saveError = { code: error.code || "OUTPUT_SAVE_FAILED", message: redact(error.message) };
      event.status = "fail";
      event.command.failureReason ||= "output-save";
    }
  }
  await withFileLock(paths.lock, async () => {
    const latestItem = await readJson(paths.state);
    const latestPlan = await readJson(paths.plan);
    if ((latestItem.revision || 1) !== event.revision || planDigest(latestItem, latestPlan) !== definition || latestItem.status !== item.status) {
      event.status = "fail";
      event.command.failureReason ||= "work-changed";
    }
    const observedAt = Date.now();
    event.command.timing = { preparationMs: startedAt - enteredAt, executionMs: endedAt - startedAt,
      evidencePreparationMs: observedAt - endedAt, observedMs: observedAt - enteredAt,
      through: "before-evidence-append", limitation: "不含进程启动、证据最终追加和状态保存；完整CLI区间由客户端事件计时。" };
    await appendJsonLine(paths.evidence, event);
    const taskSource = taskId ? latestPlan.tasks.find((task) => task.id === taskId)?.verificationSource : null;
    if (event.status !== "pass" || before.digest !== after.digest ||
      (latestItem.verification.source && latestItem.verification.source.digest !== before.digest) ||
      (taskSource && taskSource.digest !== before.digest)) {
      invalidateResults(latestItem, latestPlan, taskId);
      await atomicWriteJson(paths.plan, latestPlan);
      await atomicWriteJson(paths.state, latestItem);
    }
  });
  return event;
}
