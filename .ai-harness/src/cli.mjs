import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { checkProject, doctorProject } from "./checker.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import { runRecordedCommand } from "./evidence.mjs";
import { findProjectRoot, readJson } from "./filesystem.mjs";
import { installRuntime, initializeProject } from "./installer.mjs";
import { classifyCommand } from "./policy.mjs";
import {
  addAnalysisConclusion,
  addReviewBatch,
  addTask,
  approvePlan,
  completeBaseline,
  completeSolution,
  createWorkItemState,
  initializePlan,
  loadConfig,
  loadPlan,
  loadWorkItem,
  recordResult,
  setDatabaseDecision,
  transitionWorkItem,
  updateTaskStatus,
} from "./workflow.mjs";

const modulePath = fileURLToPath(import.meta.url);
const sourceRoot = resolve(dirname(modulePath), "..", "..");

function addOption(options, key, value) {
  if (!(key in options)) options[key] = value;
  else if (Array.isArray(options[key])) options[key].push(value);
  else options[key] = [options[key], value];
}

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  let passthrough = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      passthrough = argv.slice(index + 1);
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      addOption(options, token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      addOption(options, key, next);
      index += 1;
    } else addOption(options, key, true);
  }
  return { positional, options, passthrough };
}

function one(parsed, key, { required = false, defaultValue = null } = {}) {
  const value = parsed.options[key];
  const selected = Array.isArray(value) ? value.at(-1) : value;
  if (required) invariant(typeof selected === "string" && selected.trim(), "OPTION_REQUIRED", `缺少 --${key}。`);
  return selected ?? defaultValue;
}

function many(parsed, key) {
  const value = parsed.options[key];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

function flag(parsed, key) {
  const value = parsed.options[key];
  if (value === undefined) return false;
  const selected = Array.isArray(value) ? value.at(-1) : value;
  return selected === true || selected === "true" || selected === "1";
}

function formatHuman(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function emit(io, parsed, value) {
  io.stdout(flag(parsed, "json") ? JSON.stringify(value, null, 2) : formatHuman(value));
}

function helpText() {
  return `AI Harness Runtime

用法：node .ai-harness/bin/harness.mjs <command> [options]

项目：
  install       安装到 --target（已有规则无损合并，普通冲突默认失败）
  init          初始化项目元数据：--mode new|existing --docs default|existing
  doctor        检查 runtime、适配器、Git 和项目初始化
  check         校验全部工作项、门禁和 Git 写入范围（CI 使用 --ci）
  policies      解析适用策略：--type TYPE [--flag frontend ...]

工作项：
  start         创建工作项
  show          显示 state 和 plan
  baseline      记录 Git/文档基线
  solution      完成业务/领域/接口技术设计
  database      记录 none|required 数据库影响
  plan-init     初始化执行计划
  batch-add     增加 Review Batch
  task-add      增加任务
  plan-approve  批准计划
  task-update   推进任务状态
  record        记录验证、审查、验收、文档或分析结果
  analysis-add  增加带状态的分析结论
  transition    推进工作项状态

命令：
  guard -- <command...>          只判定 allow/ask/deny
  run --id ID [--task T] -- ...  仅执行 allow 命令并记录证据

常用重复参数：--input、--acceptance、--non-goal、--evidence、--blocked-by、--writes、--verify、--docs。`;
}

async function projectRoot() {
  return findProjectRoot(process.cwd());
}

async function listWorkItems(root) {
  const config = await loadConfig(root);
  try {
    const entries = await readdir(resolve(root, config.workItemsDirectory), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function runCli(argv, io = { stdout: console.log, stderr: console.error }) {
  const parsed = parseArgs(argv);
  const command = parsed.positional[0] || "help";
  if (["help", "--help", "-h"].includes(command)) {
    emit(io, parsed, helpText());
    return 0;
  }
  if (command === "version") {
    const manifest = await readJson(resolve(sourceRoot, ".ai-harness/manifest.json"));
    emit(io, parsed, manifest.version);
    return 0;
  }
  if (command === "install") {
    const target = one(parsed, "target", { required: true });
    const result = await installRuntime(sourceRoot, resolve(target), {
      dryRun: flag(parsed, "dry-run"),
      force: flag(parsed, "force"),
    });
    emit(io, parsed, result);
    return 0;
  }

  const root = await projectRoot();
  if (command === "init") {
    const result = await initializeProject(root, {
      mode: one(parsed, "mode", { required: true }),
      docsMode: one(parsed, "docs", { required: true }),
      force: flag(parsed, "force"),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "doctor") {
    const result = await doctorProject(root, { requireInitialized: true });
    emit(io, parsed, result);
    return result.ok ? 0 : 1;
  }
  if (command === "check") {
    const result = await checkProject(root, { ci: flag(parsed, "ci") });
    emit(io, parsed, result);
    return result.ok ? 0 : 1;
  }
  if (command === "list") {
    emit(io, parsed, await listWorkItems(root));
    return 0;
  }
  if (command === "policies") {
    const type = one(parsed, "type", { required: true }).toUpperCase();
    const index = await readJson(resolve(root, ".ai-harness/policies/index.json"));
    invariant(index.byType[type], "INVALID_WORK_TYPE", `未知工作类型：${type}`);
    const policyNames = new Set([...(index.always || []), ...index.byType[type]]);
    for (const selectedFlag of many(parsed, "flag")) {
      invariant(index.byFlag[selectedFlag], "INVALID_POLICY_FLAG", `未知策略标志：${selectedFlag}`);
      for (const name of index.byFlag[selectedFlag]) policyNames.add(name);
    }
    emit(io, parsed, [...policyNames].map((name) => `.ai-harness/policies/${name}`));
    return 0;
  }
  if (command === "start") {
    const item = await createWorkItemState(root, {
      id: one(parsed, "id", { required: true }),
      type: one(parsed, "type", { required: true }).toUpperCase(),
      title: one(parsed, "title", { required: true }),
      references: many(parsed, "input"),
      acceptance: many(parsed, "acceptance"),
      nonGoals: many(parsed, "non-goal"),
      version: one(parsed, "version"),
      authorizationMode: one(parsed, "authorization", { defaultValue: "approval-required" }),
      authorizationSource: one(parsed, "authorization-source", { required: true }),
      flags: many(parsed, "flag"),
      architectureSource: one(parsed, "architecture-source"),
      architectureApproval: one(parsed, "architecture-approval"),
      bug: one(parsed, "actual") || one(parsed, "expected") || one(parsed, "reproduction")
        ? {
            actual: one(parsed, "actual", { required: true }),
            expected: one(parsed, "expected", { required: true }),
            reproduction: one(parsed, "reproduction", { required: true }),
          }
        : null,
    });
    emit(io, parsed, item);
    return 0;
  }
  if (command === "show") {
    const id = one(parsed, "id", { required: true });
    emit(io, parsed, {
      state: await loadWorkItem(root, id),
      plan: await loadPlan(root, id, { optional: true }),
    });
    return 0;
  }
  if (command === "baseline") {
    const result = await completeBaseline(root, one(parsed, "id", { required: true }), {
      evidence: many(parsed, "evidence"),
      document: one(parsed, "document"),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "solution") {
    const result = await completeSolution(root, one(parsed, "id", { required: true }), {
      document: one(parsed, "document", { required: true }),
      evidence: many(parsed, "evidence"),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "database") {
    const result = await setDatabaseDecision(root, one(parsed, "id", { required: true }), {
      impact: one(parsed, "impact", { required: true }),
      document: one(parsed, "document"),
      evidence: many(parsed, "evidence"),
      complete: flag(parsed, "complete"),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "plan-init") {
    const result = await initializePlan(root, one(parsed, "id", { required: true }), {
      mode: one(parsed, "mode", { required: true }),
      rationale: one(parsed, "rationale", { required: true }),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "batch-add") {
    const result = await addReviewBatch(root, one(parsed, "id", { required: true }), {
      id: one(parsed, "batch", { required: true }),
      title: one(parsed, "title", { required: true }),
      risk: one(parsed, "risk", { required: true }),
      independentRequired: flag(parsed, "independent-required"),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "task-add") {
    const result = await addTask(root, one(parsed, "id", { required: true }), {
      id: one(parsed, "task", { required: true }),
      title: one(parsed, "title", { required: true }),
      module: one(parsed, "module", { required: true }),
      blockedBy: many(parsed, "blocked-by"),
      writeScopes: many(parsed, "writes"),
      verification: many(parsed, "verify"),
      docsImpact: many(parsed, "docs"),
      reviewBatch: one(parsed, "batch", { required: true }),
      risk: one(parsed, "risk", { required: true }),
      owner: one(parsed, "owner", { required: true }),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "plan-approve") {
    const result = await approvePlan(
      root,
      one(parsed, "id", { required: true }),
      one(parsed, "approval-ref", { required: true }),
    );
    emit(io, parsed, result);
    return 0;
  }
  if (command === "task-update") {
    const result = await updateTaskStatus(
      root,
      one(parsed, "id", { required: true }),
      one(parsed, "task", { required: true }),
      one(parsed, "status", { required: true }).toUpperCase(),
      {
        reason: one(parsed, "reason"),
        approvalRef: one(parsed, "approval-ref"),
      },
    );
    emit(io, parsed, result);
    return 0;
  }
  if (command === "record") {
    const result = await recordResult(root, one(parsed, "id", { required: true }), {
      kind: one(parsed, "kind", { required: true }),
      status: one(parsed, "status", { required: true }),
      summary: one(parsed, "evidence", { required: true }),
      taskId: one(parsed, "task"),
      independent: flag(parsed, "independent"),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "analysis-add") {
    const result = await addAnalysisConclusion(root, one(parsed, "id", { required: true }), {
      status: one(parsed, "status", { required: true }).toUpperCase(),
      text: one(parsed, "conclusion", { required: true }),
      evidence: many(parsed, "evidence"),
      unknown: one(parsed, "unknown"),
    });
    emit(io, parsed, result);
    return 0;
  }
  if (command === "transition") {
    const result = await transitionWorkItem(
      root,
      one(parsed, "id", { required: true }),
      one(parsed, "to", { required: true }).toUpperCase(),
      one(parsed, "reason"),
    );
    emit(io, parsed, result);
    return 0;
  }
  if (command === "guard") {
    invariant(parsed.passthrough.length > 0, "COMMAND_REQUIRED", "guard 需要在 -- 后提供命令。" );
    const config = await loadConfig(root);
    const result = classifyCommand(parsed.passthrough[0], parsed.passthrough.slice(1), config);
    emit(io, parsed, result);
    return result.decision === "allow" ? 0 : result.decision === "ask" ? 2 : 3;
  }
  if (command === "run") {
    invariant(parsed.passthrough.length > 0, "COMMAND_REQUIRED", "run 需要在 -- 后提供命令。" );
    const result = await runRecordedCommand(root, {
      id: one(parsed, "id", { required: true }),
      taskId: one(parsed, "task"),
      command: parsed.passthrough[0],
      args: parsed.passthrough.slice(1),
    });
    emit(io, parsed, result);
    return result.command.exitCode;
  }

  throw new HarnessError("UNKNOWN_COMMAND", `未知命令：${command}`);
}

export function renderError(error, json = false) {
  const payload = {
    ok: false,
    code: error.code || "UNEXPECTED_ERROR",
    message: error.message,
    details: error.details || null,
  };
  return json ? JSON.stringify(payload, null, 2) : `${payload.code}: ${payload.message}${payload.details ? `\n${JSON.stringify(payload.details, null, 2)}` : ""}`;
}
