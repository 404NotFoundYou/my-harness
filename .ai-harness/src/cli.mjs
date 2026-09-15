import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { checkProject, doctorProject } from "./checker.mjs";
import { beginWorkItem, finishWorkItem } from "./compact.mjs";
import { getWorkGuide } from "./guide.mjs";
import { checksFor } from "./verification.mjs";
import { diagnoseLegacyScopes, loadBeginSpec } from "./input.mjs";
import { itemPolicyFiles, policyFilesFor } from "./policy-routing.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import { runRecordedCommand } from "./evidence.mjs";
import { findProjectRoot, readJson } from "./filesystem.mjs";
import { installRuntime, initializeProject, uninstallRuntime } from "./installer.mjs";
import { classifyCommand } from "./policy.mjs";
import {
  addAnalysisConclusion,
  addReviewBatch,
  addTask,
  approvePlan,
  completeBaseline,
  completeSolution,
  editTask,
  createWorkItemState,
  initializePlan,
  loadConfig,
  loadPlan,
  loadWorkItem,
  recordResult,
  reopenWorkItem,
  recoverWorkItemLock,
  workItemLockStatus,
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
  uninstall     从 --target 安全卸载（预检用 --dry-run，正式执行需 --confirm）
  init          初始化项目元数据：--mode new|existing --docs default|existing
  doctor        检查 runtime、适配器、Git 和项目初始化
  check         校验全部工作项、门禁和 Git 写入范围（CI 使用 --ci）
  policies      读取实际策略：--id ID；或 --type TYPE [--flag frontend ...] [--database-impact none|required|unknown]

工作项：
  begin         普通任务：一次建立基线、简短方案和单任务计划并开始实施
  finish        普通任务：引用成功命令和实际审查/验收结论完成工作项
  start         创建工作项
  show          显示 state 和 plan
  guide         只读任务引导：--id ID [--task T] [--context] [--context-since FILE] [--brief]
  lock-status   查看工作项锁所有者与是否失活：--id ID
  lock-recover  恢复确定失活的新格式锁：--id ID --token TOKEN --reason TEXT
  reopen        返工并失效旧验证：--id ID --reason TEXT [--approval-ref REF]
  replan        保存旧计划版本后重新计划：--id ID --reason TEXT [--approval-ref REF]
  baseline      记录 Git/文档基线
  solution      完成业务/领域/接口技术设计
  database      记录 none|required 数据库影响
  plan-init     初始化执行计划
  batch-add     增加 Review Batch
  task-add      增加任务
  task-edit     修改未批准的任务定义（已批准任务需先 replan）
  plan-approve  批准计划
  task-update   推进任务状态
  record        记录验证、审查、验收、文档或分析结果（流水线用 --stage；reproduction/regression 用 --command 引用 run 证据）
  analysis-add  增加带状态的分析结论
  transition    推进工作项状态

命令：
  guard -- <command...>          只判定 allow/ask/deny
  run --id ID [--task T] -- ...  仅执行 allow 命令并记录证据
  run --id ID --task T --all    顺序执行本任务已声明检查，遇失败停止并列出未运行项

普通任务：
  begin --spec task.json [--json]  项目内UTF-8 JSON，数组字段详见 schemas/begin-spec.schema.json；不与任务定义参数混用
  begin --id ID --type ITERATION|BUGFIX --title TITLE --input SOURCE --acceptance CONDITION
        --authorization-source SOURCE --risk low|medium --approach TEXT --database-evidence TEXT
        --writes PATH --verify COMMAND --docs PATH_OR_NA [--flag frontend]
  run --id ID --task T1 -- <COMMAND> [ARGS...]
  finish --id ID --command EVIDENCE_ID --verification TEXT --review TEXT --documentation TEXT --acceptance TEXT
         [--stage-evidence stage=TEXT] [--stage-command stage=EVIDENCE_ID]
  finish 可从合法中间状态继续；已通过且仍有效的结论无需重复提交，省略 --command 时匹配本项当前成功检查；不会自动执行未跑的测试
  check --ci --json
  begin 默认为 autonomous；授权来源必须真实。BUGFIX 另需 --actual、--expected、--reproduction。
  BUGFIX 的 finish 另需必需阶段的 --stage-evidence，复现/回归另需 --stage-command；按原流水线顺序登记。
  复杂/高风险或需要逐步批准的工作仍使用 start 及细粒度命令。

record 可用 --artifact PATH（最多8项）及 --artifact-source TEXT 保存带哈希的产物副本。
常用重复参数：--input、--acceptance、--non-goal、--evidence、--blocked-by、--writes、--verify、--docs、--command、--artifact。`;
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
  if (command === "uninstall") {
    const target = one(parsed, "target", { required: true });
    const result = await uninstallRuntime(sourceRoot, resolve(target), {
      dryRun: flag(parsed, "dry-run"),
      confirm: flag(parsed, "confirm"),
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
    const index = await readJson(resolve(root, ".ai-harness/policies/index.json"));
    if (one(parsed, "id")) {
      invariant(!one(parsed, "type") && !one(parsed, "database-impact") && many(parsed, "flag").length === 0, "POLICY_OPTION_CONFLICT", "按 --id 读取时不能覆盖工作项的类型、标志或数据库判断。" );
      emit(io, parsed, itemPolicyFiles(index, await loadWorkItem(root, one(parsed, "id"))));
    } else emit(io, parsed, policyFilesFor(index, one(parsed, "type", { required: true }).toUpperCase(), many(parsed, "flag"), { databaseImpact: one(parsed, "database-impact", { defaultValue: "unknown" }) }));
    return 0;
  }
  if (command === "start" || command === "begin") {
    if (command === "begin" && one(parsed, "spec")) {
      invariant(Object.keys(parsed.options).every(key => ["spec", "json"].includes(key)) && parsed.positional.length === 1 && parsed.passthrough.length === 0, "SPEC_OPTION_CONFLICT", "--spec 不能与命令行任务定义混用；请把完整定义放入 JSON。" );
      emit(io, parsed, await beginWorkItem(root, await loadBeginSpec(root, one(parsed, "spec", { required: true }))));
      return 0;
    }
    const options = {
      id: one(parsed, "id", { required: true }),
      type: one(parsed, "type", { required: true }).toUpperCase(),
      title: one(parsed, "title", { required: true }),
      references: many(parsed, "input"),
      acceptance: many(parsed, "acceptance"),
      nonGoals: many(parsed, "non-goal"),
      version: one(parsed, "version"),
      authorizationMode: one(parsed, "authorization", { defaultValue: command === "begin" ? "autonomous" : "approval-required" }),
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
    };
    if (command === "begin") await diagnoseLegacyScopes(root, many(parsed, "writes"));
    const item = command === "begin"
      ? await beginWorkItem(root, {
          ...options,
          risk: one(parsed, "risk", { required: true }),
          approach: one(parsed, "approach", { required: true }),
          databaseEvidence: one(parsed, "database-evidence", { required: true }),
          writeScopes: many(parsed, "writes"),
          verification: many(parsed, "verify"),
          docsImpact: many(parsed, "docs"),
        })
      : await createWorkItemState(root, options);
    emit(io, parsed, item);
    return 0;
  }
  if (command === "finish") {
    const result = await finishWorkItem(root, one(parsed, "id", { required: true }), {
      commandIds: many(parsed, "command"),
      verification: one(parsed, "verification"),
      review: one(parsed, "review"),
      documentation: one(parsed, "documentation"),
      acceptance: one(parsed, "acceptance"),
      stageEvidence: many(parsed, "stage-evidence"),
      stageCommands: many(parsed, "stage-command"),
    });
    emit(io, parsed, result);
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
  if (command === "guide") {
    emit(io, parsed, await getWorkGuide(root, one(parsed, "id", { required: true }), {
      taskId: one(parsed, "task"),
      includeContext: flag(parsed, "context"),
      contextSince: one(parsed, "context-since", { required: parsed.options["context-since"] !== undefined }),
      brief: flag(parsed, "brief"),
    }));
    return 0;
  }
  if (command === "lock-status") {
    emit(io, parsed, await workItemLockStatus(root, one(parsed, "id", { required: true })));
    return 0;
  }
  if (command === "lock-recover") {
    const result = await recoverWorkItemLock(root, one(parsed, "id", { required: true }), {
      token: one(parsed, "token", { required: true }), reason: one(parsed, "reason", { required: true }),
    });
    emit(io, parsed, result);
    return result.ok ? 0 : 1;
  }
  if (command === "reopen" || command === "replan") {
    const id = one(parsed, "id", { required: true });
    const result = await reopenWorkItem(root, id, {
      reason: one(parsed, "reason", { required: true }), replan: command === "replan", approvalRef: one(parsed, "approval-ref"),
    });
    const guide = await getWorkGuide(root, id);
    emit(io, parsed, { ...result, tasks: guide.tasks, next: guide.next });
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
  if (command === "task-edit") {
    const changes = {};
    for (const [option, property] of [["title", "title"], ["module", "module"], ["batch", "reviewBatch"], ["risk", "risk"], ["owner", "owner"]]) {
      if (parsed.options[option] !== undefined) changes[property] = one(parsed, option, { required: true });
    }
    for (const [option, property] of [["writes", "writeScopes"], ["verify", "verification"], ["docs", "docsImpact"], ["blocked-by", "blockedBy"]]) {
      if (parsed.options[option] !== undefined) changes[property] = many(parsed, option);
    }
    emit(io, parsed, await editTask(root, one(parsed, "id", { required: true }), one(parsed, "task", { required: true }), changes));
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
      stage: one(parsed, "stage"),
      commandRef: one(parsed, "command"),
      artifactPaths: many(parsed, "artifact"),
      artifactSource: one(parsed, "artifact-source"),
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
    if (flag(parsed, "all")) {
      invariant(!one(parsed, "check") && parsed.passthrough.length === 0, "CONFLICTING_CHECK_SELECTION", "--all 不能与 --check 或透传命令混用。" );
      const id = one(parsed, "id", { required: true });
      const taskId = one(parsed, "task", { required: true });
      const plan = await loadPlan(root, id);
      const task = plan.tasks.find(entry => entry.id === taskId);
      invariant(task, "TASK_NOT_FOUND", `任务不存在：${taskId}`);
      const checks = checksFor(task), commands = [];
      invariant(checks.length > 0, "VERIFICATION_REQUIRED", "任务没有可执行的计划检查。" );
      let blockedCheck = null;
      for (const check of checks) {
        try {
          const event = await runRecordedCommand(root, { id, taskId, checkId: check.id });
          commands.push({ id: event.id, checkId: check.id, status: event.status, exitCode: event.command.exitCode, stdout: event.command.stdout, stderr: event.command.stderr });
          if (event.status !== "pass") break;
        } catch (error) {
          blockedCheck = { checkId: check.id, code: error.code || "UNEXPECTED_ERROR", message: error.message };
          break;
        }
      }
      const passed = commands.length === checks.length && commands.every(entry => entry.status === "pass") && !blockedCheck;
      emit(io, parsed, { id, taskId, status: passed ? "pass" : "fail", commands, blockedCheck, notRun: checks.slice(commands.length).map(check => check.id) });
      return passed ? 0 : 1;
    }
    invariant(parsed.passthrough.length > 0 || one(parsed, "check"), "COMMAND_REQUIRED", "run 需要 --check 或在 -- 后提供命令。" );
    const result = await runRecordedCommand(root, {
      id: one(parsed, "id", { required: true }),
      taskId: one(parsed, "task"),
      command: parsed.passthrough[0],
      args: parsed.passthrough.slice(1),
      checkId: one(parsed, "check"),
    });
    emit(io, parsed, result);
    return result.status === "pass" ? 0 : result.command.exitCode || 1;
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
