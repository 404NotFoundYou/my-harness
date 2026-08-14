import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { appendJsonLine, withFileLock } from "./filesystem.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import { classifyCommand } from "./policy.mjs";
import { loadConfig, loadPlan, loadWorkItem, workItemPaths } from "./workflow.mjs";

const decoder = new TextDecoder("utf-8", { fatal: false });

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function redact(value) {
  return String(value)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\b(ghp|github_pat|sk|pk_live|AKIA)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*([^\s]+)/g, "$1=[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]");
}

function capture(buffer, maxBytes) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  const truncated = source.length > maxBytes;
  const visible = truncated ? source.subarray(0, maxBytes) : source;
  return {
    text: redact(decoder.decode(visible)),
    bytes: source.length,
    truncated,
    sha256: sha256(source),
  };
}

function redactedArgs(args) {
  return args.map((arg) => redact(arg));
}

export async function runRecordedCommand(root, { id, taskId = null, command, args = [] }) {
  const item = await loadWorkItem(root, id);
  invariant(item.status === "IMPLEMENTING" || item.status === "VERIFYING", "WRONG_STAGE", "受控命令只允许在 IMPLEMENTING 或 VERIFYING 阶段运行。" );
  invariant(typeof command === "string" && command.trim() && Array.isArray(args) && args.every((arg) => typeof arg === "string"), "INVALID_COMMAND", "命令和参数必须是字符串数组。" );
  invariant(item.status !== "IMPLEMENTING" || taskId, "TASK_REQUIRED", "IMPLEMENTING 阶段运行命令必须绑定任务。" );
  if (taskId) {
    const plan = await loadPlan(root, id);
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    invariant(task, "TASK_NOT_FOUND", `任务不存在：${taskId}`);
    invariant(task.status === "IN_PROGRESS", "WRONG_TASK_STAGE", "受控命令只能绑定 IN_PROGRESS 任务。" );
  }
  const config = await loadConfig(root);
  const classification = classifyCommand(command, args, config);
  if (classification.decision !== "allow") {
    throw new HarnessError(
      classification.decision === "deny" ? "COMMAND_DENIED" : "COMMAND_REQUIRES_APPROVAL",
      classification.reason,
      classification,
    );
  }

  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: null,
    shell: false,
    windowsHide: true,
    timeout: config.commandTimeoutMs,
    maxBuffer: Math.max(config.maxCapturedOutputBytes * 16, 1024 * 1024),
  });
  const endedAt = Date.now();
  const stdout = capture(result.stdout, config.maxCapturedOutputBytes);
  const stderr = capture(result.stderr, config.maxCapturedOutputBytes);
  const timedOut = result.error?.code === "ETIMEDOUT";
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const paths = await workItemPaths(root, id);
  const event = {
    schemaVersion: 1,
    id: randomUUID(),
    workItemId: id,
    taskId,
    kind: "command",
    status: exitCode === 0 && !timedOut ? "pass" : "fail",
    summary: `${redact(command)} ${redactedArgs(args).join(" ")}`.trim(),
    timestamp: new Date(startedAt).toISOString(),
    command: {
      executable: redact(command),
      args: redactedArgs(args),
      cwd: ".",
      policy: classification,
      exitCode,
      signal: result.signal || null,
      timedOut,
      durationMs: endedAt - startedAt,
      stdout,
      stderr,
      spawnError: result.error ? redact(result.error.message) : null,
    },
  };
  await withFileLock(paths.lock, () => appendJsonLine(paths.evidence, event));
  return event;
}
