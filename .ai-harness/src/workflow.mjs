import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  appendJsonLine,
  atomicWriteJson,
  exists,
  readJson,
  resolveProjectPath,
  withFileLock,
} from "./filesystem.mjs";
import { getGitBaseline } from "./git.mjs";
import { inspectLock, recoverLock } from "./locking.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import {
  aggregateVerificationStatus,
  EVIDENCE_KINDS,
  isDevelopmentType,
  isRunBackedStage,
  nowIso,
  POLICY_FLAGS,
  requiredVerificationStages,
  RESULT_STATUSES,
  usesVerificationPipeline,
  VERIFICATION_STAGES,
  WORK_ID_PATTERN,
  WORK_TYPES,
} from "./constants.mjs";
import { createPlan, createReviewBatch, createTask, createWorkItem } from "./model.mjs";
import { assertAcceptanceCoverage, assertCommandEvidence, assertVerification, hasFailedReview, invalidateResults, planDigest, readEvidence } from "./verification.mjs";
import { captureArtifacts } from "./artifacts.mjs";
import { saveSnapshot, sourceSnapshot } from "./snapshot.mjs";
import { prepareDelivery } from "./scope.mjs";
import { itemPolicyFiles, policyFilesFor } from "./policy-routing.mjs";
import {
  assertTaskTransition,
  assertTransitionAllowed,
  assertTransitionGates,
  assertValidPlan,
  assertValidWorkItem,
  collectProgressErrors,
  taskDependenciesComplete,
} from "./validator.mjs";

export async function loadConfig(root) {
  return readJson(path.join(root, ".ai-harness", "config.json"));
}

export async function workItemPaths(root, id) {
  invariant(WORK_ID_PATTERN.test(id || ""), "INVALID_WORK_ID", "工作项 ID 格式无效。" );
  const config = await loadConfig(root);
  const directory = await resolveProjectPath(root, `${config.workItemsDirectory}/${id}`, { forWrite: true });
  return {
    directory,
    state: path.join(directory, "state.json"),
    plan: path.join(directory, "plan.json"),
    evidence: path.join(directory, "evidence.jsonl"),
    events: path.join(directory, "events.jsonl"),
    lock: path.join(directory, ".lock"),
  };
}

export async function loadWorkItem(root, id) {
  const paths = await workItemPaths(root, id);
  const item = await readJson(paths.state);
  assertValidWorkItem(item);
  return item;
}

export async function loadPlan(root, id, { optional = false } = {}) {
  const paths = await workItemPaths(root, id);
  if (optional && !(await exists(paths.plan))) return null;
  return readJson(paths.plan);
}

async function appendEvent(paths, workItemId, action, details = {}) {
  await appendJsonLine(paths.events, {
    schemaVersion: 1,
    id: randomUUID(),
    workItemId,
    action,
    timestamp: nowIso(),
    ...details,
  });
}

export async function createWorkItemState(root, options) {
  invariant(WORK_ID_PATTERN.test(options.id || ""), "INVALID_WORK_ID", "工作项 ID 格式无效。" );
  invariant(WORK_TYPES.includes(options.type), "INVALID_WORK_TYPE", `未知工作类型：${options.type}`);
  const flags = [...new Set(options.flags || [])];
  for (const flag of flags) invariant(POLICY_FLAGS.includes(flag), "INVALID_POLICY_FLAG", `未知策略标志：${flag}`);
  const policyIndex = await readJson(path.join(root, ".ai-harness", "policies", "index.json"));
  if (options.type === "NEW_PROJECT") {
    invariant(["HUMAN_PROVIDED", "AI_RECOMMENDED"].includes(options.architectureSource), "ARCHITECTURE_SOURCE_REQUIRED", "新项目必须提供架构来源。" );
    invariant(options.architectureApproval?.trim(), "ARCHITECTURE_APPROVAL_REQUIRED", "新项目必须提供架构批准/授权引用。" );
  }
  if (options.type === "BUGFIX") {
    invariant(options.bug?.actual?.trim() && options.bug?.expected?.trim() && options.bug?.reproduction?.trim(), "BUG_BASELINE_REQUIRED", "BUGFIX 必须提供实际行为、期望行为和复现路径。" );
  }
  const paths = await workItemPaths(root, options.id);
  invariant(!(await exists(paths.state)), "WORK_ITEM_EXISTS", `工作项已存在：${options.id}`);
  const normalizedOptions = {
    ...options,
    version: options.version || (options.type === "NEW_PROJECT" ? "v1.0" : null),
    flags,
    policyFiles: policyFilesFor(policyIndex, options.type, flags),
  };
  const item = createWorkItem(normalizedOptions);
  assertValidWorkItem(item);
  await atomicWriteJson(paths.state, item);
  await appendEvent(paths, item.id, "work-item-created", { status: item.status, type: item.type });
  return item;
}

async function assertNewProjectDocs(root, version) {
  const required = [
    "README.md",
    "docs/README.md",
    "docs/product/overview.md",
    "docs/architecture/overview.md",
    `docs/versions/${version}/README.md`,
    `docs/versions/${version}/STATE.md`,
  ];
  for (const relative of required) {
    const absolute = await resolveProjectPath(root, relative, { mustExist: true });
    const content = await readFile(absolute, "utf8");
    invariant(!content.includes("HARNESS:REQUIRED"), "DOCS_INCOMPLETE", `新项目基线文档尚未填写：${relative}`);
  }
}

async function mutateWorkItem(root, id, mutator) {
  const paths = await workItemPaths(root, id);
  return withFileLock(paths.lock, async () => {
    const item = await readJson(paths.state);
    assertValidWorkItem(item);
    const result = await mutator(item, paths);
    item.updatedAt = nowIso();
    assertValidWorkItem(item);
    await atomicWriteJson(paths.state, item);
    return result ?? item;
  });
}

async function mutatePlan(root, id, mutator) {
  const paths = await workItemPaths(root, id);
  return withFileLock(paths.lock, async () => {
    const item = await readJson(paths.state);
    assertValidWorkItem(item);
    const plan = await readJson(paths.plan);
    const result = await mutator(plan, item, paths);
    plan.updatedAt = nowIso();
    assertValidPlan(plan, id);
    await atomicWriteJson(paths.plan, plan);
    item.updatedAt = nowIso();
    assertValidWorkItem(item);
    await atomicWriteJson(paths.state, item);
    return result ?? plan;
  });
}

export async function completeBaseline(root, id, { evidence, document = null }) {
  invariant(Array.isArray(evidence) && evidence.length > 0, "EVIDENCE_REQUIRED", "基线至少需要一条证据。" );
  if (document) await resolveProjectPath(root, document, { mustExist: true });
  const repository = await getGitBaseline(root);
  const config = await loadConfig(root);
  invariant(!config.requireGit || repository.isGit, "GIT_REQUIRED", "项目配置要求 Git，但当前目录不是 Git 仓库。" );
  return mutateWorkItem(root, id, async (item, paths) => {
    invariant(item.status === "BASELINING", "WRONG_STAGE", "只能在 BASELINING 阶段完成基线。" );
    if (config.requireGit && isDevelopmentType(item.type)) {
      invariant(repository.commit, "GIT_COMMIT_REQUIRED", "开发型工作建立基线前必须先创建 Git 初始提交，确保后续写入范围可验证。" );
    }
    if (item.type === "NEW_PROJECT") await assertNewProjectDocs(root, item.input.version || "v1.0");
    item.baseline = {
      status: "complete",
      document,
      evidence,
      completedAt: nowIso(),
      repository,
    };
    item.baseline.repository.source = await saveSnapshot(root, paths.directory, await sourceSnapshot(root));
    await appendEvent(paths, id, "baseline-completed", { repository, evidence });
  });
}

export async function completeSolution(root, id, { document, evidence }) {
  invariant(document?.trim(), "DOCUMENT_REQUIRED", "技术设计必须提供文档路径。" );
  invariant(Array.isArray(evidence) && evidence.length > 0, "EVIDENCE_REQUIRED", "技术设计至少需要一条证据。" );
  await resolveProjectPath(root, document, { mustExist: true });
  return mutateWorkItem(root, id, async (item, paths) => {
    invariant(item.status === "SOLUTION_DESIGN", "WRONG_STAGE", "只能在 SOLUTION_DESIGN 阶段完成技术设计。" );
    item.solution = {
      status: "complete",
      document,
      evidence,
      completedAt: nowIso(),
    };
    await appendEvent(paths, id, "solution-completed", { document, evidence });
  });
}

export async function setDatabaseDecision(root, id, { impact, document = null, evidence, complete = false }) {
  invariant(["none", "required"].includes(impact), "INVALID_DATABASE_IMPACT", "数据库影响只能是 none 或 required。" );
  invariant(Array.isArray(evidence) && evidence.length > 0, "EVIDENCE_REQUIRED", "数据库判断至少需要一条证据。" );
  if (document) await resolveProjectPath(root, document, { mustExist: true });
  return mutateWorkItem(root, id, async (item, paths) => {
    invariant(item.type !== "ANALYSIS", "TYPE_MISMATCH", "ANALYSIS 不进入数据库门禁。" );
    invariant(["SOLUTION_DESIGN", "DATABASE_DESIGN"].includes(item.status), "WRONG_STAGE", "数据库判断只能在 SOLUTION_DESIGN 或 DATABASE_DESIGN 阶段更新。" );
    if (impact === "none") {
      item.database = {
        impact,
        status: "not-applicable",
        document,
        evidence,
        completedAt: nowIso(),
      };
    } else {
      invariant(!complete || document, "DOCUMENT_REQUIRED", "完成数据库设计必须提供文档路径。" );
      item.database = {
        impact,
        status: complete ? "complete" : "pending",
        document,
        evidence,
        completedAt: complete ? nowIso() : null,
      };
    }
    item.policyFiles = itemPolicyFiles(await readJson(path.join(root, ".ai-harness/policies/index.json")), item);
    await appendEvent(paths, id, "database-decision", {
      impact,
      status: item.database.status,
      document,
      evidence,
    });
  });
}

export async function initializePlan(root, id, { mode, rationale }) {
  invariant(["single", "multi"].includes(mode), "INVALID_PLAN_MODE", "计划模式必须是 single 或 multi。" );
  const paths = await workItemPaths(root, id);
  return withFileLock(paths.lock, async () => {
    const item = await readJson(paths.state);
    assertValidWorkItem(item);
    invariant(item.type !== "ANALYSIS", "TYPE_MISMATCH", "ANALYSIS 不创建开发计划。" );
    invariant(mode !== "multi" || item.flags.includes("multi-agent"), "MULTI_AGENT_POLICY_REQUIRED", "multi 计划必须在工作项中启用 multi-agent 策略标志。" );
    invariant(["SOLUTION_DESIGN", "DATABASE_DESIGN"].includes(item.status), "WRONG_STAGE", "执行计划只能在技术/数据库设计完成后建立。" );
    invariant(item.solution.status === "complete", "SOLUTION_REQUIRED", "建立计划前必须完成技术设计。" );
    invariant(item.database.impact !== "unknown", "DATABASE_DECISION_REQUIRED", "建立计划前必须完成数据库影响判断。" );
    if (item.database.impact === "required") {
      invariant(item.database.status === "complete", "DATABASE_DESIGN_REQUIRED", "建立计划前必须完成数据库设计。" );
    }
    invariant(!(await exists(paths.plan)), "PLAN_EXISTS", "计划已经存在。" );
    const plan = createPlan({ workItemId: id, mode, rationale });
    await atomicWriteJson(paths.plan, plan);
    await appendEvent(paths, id, "plan-initialized", { mode, rationale });
    return plan;
  });
}

export async function addReviewBatch(root, id, options) {
  return mutatePlan(root, id, async (plan, item, paths) => {
    invariant(!item.plan.approved, "PLAN_LOCKED", "已批准计划不能直接增加 Review Batch。" );
    invariant(!plan.reviewBatches.some((batch) => batch.id === options.id), "BATCH_EXISTS", `Review Batch 已存在：${options.id}`);
    plan.reviewBatches.push(createReviewBatch(options));
    await appendEvent(paths, id, "review-batch-added", { batchId: options.id });
  });
}

export async function addTask(root, id, options) {
  return mutatePlan(root, id, async (plan, item, paths) => {
    invariant(!item.plan.approved, "PLAN_LOCKED", "已批准计划不能直接增加任务。" );
    invariant(!plan.tasks.some((task) => task.id === options.id), "TASK_EXISTS", `任务已存在：${options.id}`);
    const batch = plan.reviewBatches.find((candidate) => candidate.id === options.reviewBatch);
    invariant(batch, "BATCH_NOT_FOUND", `Review Batch 不存在：${options.reviewBatch}`);
    for (const dependency of options.blockedBy || []) {
      invariant(plan.tasks.some((task) => task.id === dependency), "DEPENDENCY_NOT_FOUND", `依赖任务不存在：${dependency}`);
    }
    const task = createTask(options);
    plan.tasks.push(task);
    batch.taskIds.push(task.id);
    for (const dependency of task.blockedBy) {
      const parent = plan.tasks.find((candidate) => candidate.id === dependency);
      parent.blocks.push(task.id);
    }
    await appendEvent(paths, id, "task-added", { taskId: task.id, reviewBatch: task.reviewBatch });
    return task;
  });
}

export async function approvePlan(root, id, approvalRef) {
  invariant(approvalRef?.trim(), "APPROVAL_REQUIRED", "批准计划必须提供授权引用。" );
  return mutatePlan(root, id, async (plan, item, paths) => {
    assertValidPlan(plan, id, { requireContent: true });
    assertAcceptanceCoverage(item, plan);
    item.plan.approved = true;
    item.plan.approvalRef = approvalRef;
    await appendEvent(paths, id, "plan-approved", { approvalRef });
  });
}

export async function transitionWorkItem(root, id, target, reason = null) {
  const paths = await workItemPaths(root, id);
  return withFileLock(paths.lock, async () => {
    const item = await readJson(paths.state);
    const plan = (await exists(paths.plan)) ? await readJson(paths.plan) : null;
    assertValidWorkItem(item);
    assertTransitionAllowed(item, target, reason);
    await assertTransitionGates(root, item, plan, target);
    const from = item.status;
    if (target === "DONE") {
      const current = await sourceSnapshot(root);
      const delivery = await prepareDelivery(root, item, plan, current);
      const baseline = await saveSnapshot(root, paths.directory, delivery.baseline);
      item.integrityVersion = 1;
      item.revision ||= 1;
      item.delivery = { source: await saveSnapshot(root, paths.directory, current), baseline, baselineAt: delivery.baselineAt, ownedChanges: delivery.ownedChanges, planDigest: planDigest(item, plan), at: nowIso(), head: (await getGitBaseline(root)).commit };
    }
    if (target === "BLOCKED") {
      item.blocked = { from, reason, at: nowIso() };
    } else if (from === "BLOCKED") {
      item.blocked = null;
    }
    item.status = target;
    item.updatedAt = nowIso();
    item.history.push({
      from,
      to: target,
      at: item.updatedAt,
      reason: target === "BLOCKED" ? reason : from === "BLOCKED" ? "unblocked" : reason || "gate-passed",
      ...(from === "BLOCKED" ? { unblockedTo: target } : {}),
    });
    assertValidWorkItem(item);
    await atomicWriteJson(paths.state, item);
    await appendEvent(paths, id, "state-transition", { from, to: target, reason });
    return item;
  });
}

export async function updateTaskStatus(root, id, taskId, target, { reason = null, approvalRef = null } = {}) {
  return mutatePlan(root, id, async (plan, item, paths) => {
    invariant(item.status === "IMPLEMENTING", "WRONG_STAGE", "任务状态只能在 IMPLEMENTING 阶段推进。" );
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    invariant(task, "TASK_NOT_FOUND", `任务不存在：${taskId}`);
    assertTaskTransition(plan, task, target, approvalRef);
    if (target === "BLOCKED") invariant(reason?.trim(), "BLOCK_REASON_REQUIRED", "阻塞任务必须提供原因。" );
    const from = task.status;
    task.status = target;
    if (target === "IN_PROGRESS") task.attempt = (task.attempt || 0) + 1;
    if (target === "DEFERRED") task.deferralApproval = approvalRef;
    if (target === "REWORK") {
      task.verificationStatus = "pending";
      task.reviewStatus = "pending";
      delete task.verificationSource;
      delete task.reviewSource;
      invalidateResults(item, plan);
    }

    if (["COMPLETED", "DEFERRED"].includes(target)) {
      for (const candidate of plan.tasks.filter((entry) => entry.status === "PENDING")) {
        if (taskDependenciesComplete(plan, candidate)) candidate.status = "READY";
      }
    }
    assertValidPlan(plan, id, { requireContent: true });
    await appendEvent(paths, id, "task-transition", { taskId, from, to: target, reason, approvalRef });
    return task;
  });
}

function createEvidenceEvent({ id, taskId = null, kind, status, summary, command = null, independent = false, stage = null }) {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    workItemId: id,
    taskId,
    kind,
    status,
    summary,
    timestamp: nowIso(),
    command,
    independent,
    stage,
  };
}

function assertResultStage(item, kind) {
  const requiredStage = {
    verification: "VERIFYING",
    documentation: "VERIFYING",
    review: "CODE_REVIEW",
    acceptance: "READY_FOR_ACCEPTANCE",
    analysis: "ANALYZING",
  }[kind];
  invariant(!requiredStage || item.status === requiredStage, "WRONG_STAGE", `${kind} 结果只能在 ${requiredStage} 阶段记录。`);
}

async function findEvidenceById(paths, evidenceId) {
  let raw = "";
  try {
    raw = await readFile(paths.evidence, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.id === evidenceId) return event;
  }
  return null;
}

export async function recordResult(root, id, { kind, status, summary, taskId = null, independent = false, stage = null, commandRef = null, artifactPaths = [], artifactSource = null }) {
  invariant(Array.isArray(artifactPaths), "ARTIFACT_INVALID", "artifactPaths 必须是路径数组。" );
  invariant(EVIDENCE_KINDS.filter((value) => value !== "command").includes(kind), "INVALID_EVIDENCE_KIND", `不支持的证据类型：${kind}`);
  invariant(RESULT_STATUSES.includes(status), "INVALID_RESULT_STATUS", `无效结果状态：${status}`);
  invariant(summary?.trim(), "EVIDENCE_REQUIRED", "证据摘要不能为空。" );
  if (stage !== null) {
    invariant(kind === "verification", "STAGE_KIND_MISMATCH", "只有 verification 证据支持 --stage。" );
    invariant(taskId === null, "STAGE_TASK_CONFLICT", "验证子阶段是工作项级证据，不能绑定任务。" );
    invariant(VERIFICATION_STAGES.some((entry) => entry.stage === stage), "INVALID_VERIFICATION_STAGE", `未知验证子阶段：${stage}`);
    if (isRunBackedStage(stage)) {
      invariant(typeof commandRef === "string" && commandRef.trim(), "STAGE_RUN_REQUIRED", `${stage} 子阶段必须引用一次 harness run 的通过命令证据（--command <id>）。`);
    } else {
      invariant(commandRef === null, "STAGE_COMMAND_NOT_ALLOWED", `${stage} 子阶段不接受 --command。`);
    }
  } else {
    invariant(commandRef === null, "STAGE_COMMAND_NOT_ALLOWED", "--command 只能与验证子阶段一起使用。" );
  }
  const paths = await workItemPaths(root, id);
  return withFileLock(paths.lock, async () => {
    const item = await readJson(paths.state);
    const plan = (await exists(paths.plan)) ? await readJson(paths.plan) : null;
    assertValidWorkItem(item);
    let task = null;

    if (taskId) {
      invariant(item.status === "IMPLEMENTING", "WRONG_STAGE", "任务证据只能在 IMPLEMENTING 阶段记录。" );
      invariant(plan, "PLAN_REQUIRED", "任务证据需要执行计划。" );
      task = plan.tasks.find((candidate) => candidate.id === taskId);
      invariant(task, "TASK_NOT_FOUND", `任务不存在：${taskId}`);
      invariant(["verification", "review"].includes(kind), "INVALID_TASK_EVIDENCE", "任务只接受 verification 或 review 证据。" );
      const requiredTaskStage = kind === "verification" ? "IN_PROGRESS" : "IN_REVIEW";
      invariant(task.status === requiredTaskStage, "WRONG_TASK_STAGE", `${kind} 证据只能在任务 ${requiredTaskStage} 状态记录。`);
    } else if (kind !== "checkpoint") {
      assertResultStage(item, kind);
    }

    // codegen 工作项或 BUGFIX 类型的工作项级 verification 必须走子阶段流水线，禁止裸记录绕过。
    if (kind === "verification" && !taskId && usesVerificationPipeline(item)) {
      invariant(stage !== null, "VERIFICATION_STAGE_REQUIRED", "该工作项必须用 --stage 记录验证子阶段。" );
    }

    if (kind === "review" && status === "pass") {
      invariant(!hasFailedReview(await readEvidence(root, id), item, task), "REVIEW_REWORK_REQUIRED",
        task ? "审查失败后必须先 REWORK，再开始新的任务尝试。" : "最终审查失败后必须先 reopen，建立新修订再验证和审查。");
    }

    let verificationSource = null;
    if (status === "pass" && isDevelopmentType(item.type) && ["verification", "review", "acceptance"].includes(kind)) {
      if (kind !== "verification" || stage === null) await assertVerification(root, item, plan, { taskId });
      verificationSource = await saveSnapshot(root, paths.directory, await sourceSnapshot(root));
      if (stage && item.verification.source && item.verification.source.digest !== verificationSource.digest) invalidateResults(item, plan);
    }

    // 顺序守卫：把某阶段记为 pass 前，其之前的所有“必需”阶段必须已 pass。
    if (stage !== null && status === "pass") {
      const requiredNames = requiredVerificationStages(item);
      const order = VERIFICATION_STAGES.map((entry) => entry.stage);
      const priorRequired = order.slice(0, order.indexOf(stage)).filter((name) => requiredNames.includes(name));
      const statusByStage = new Map((item.verification.stages || []).map((entry) => [entry.stage, entry.status]));
      const missing = priorRequired.filter((name) => statusByStage.get(name) !== "pass");
      invariant(missing.length === 0, "VERIFICATION_STAGE_ORDER", `子阶段 ${stage} 之前的必需阶段尚未通过：${missing.join(", ")}`, { missing });
    }

    // run-backed 阶段（reproduction/regression）必须引用一条真实通过的命令证据。
    if (stage !== null && isRunBackedStage(stage)) {
      const commandEvent = await findEvidenceById(paths, commandRef);
      invariant(commandEvent && commandEvent.kind === "command" && commandEvent.workItemId === id, "STAGE_RUN_EVIDENCE_INVALID", `--command 未指向本工作项的命令证据：${commandRef}`);
      if (status === "pass") {
        invariant(commandEvent.status === "pass", "STAGE_RUN_EVIDENCE_NOT_PASSING", `${stage} 记为 pass 需引用通过的命令证据，但 ${commandRef} 未通过。`);
        await assertCommandEvidence(root, item, plan, commandRef);
      }
    }

    const event = createEvidenceEvent({ id, taskId, kind, status, summary, independent, stage });
    if (artifactPaths.length || artifactSource !== null) event.artifacts = await captureArtifacts(root, id, artifactPaths, artifactSource);
    event.revision = item.revision || 1;
    event.taskAttempt = task ? task.attempt || 1 : null;
    if (commandRef) event.commandRef = commandRef;
    if (verificationSource) {
      event.source = verificationSource;
      event.planDigest = planDigest(item, plan);
    }
    await appendJsonLine(paths.evidence, event);

    if (task) {
      if (kind === "verification") task.verificationStatus = status;
      if (kind === "review") task.reviewStatus = status;
      if (verificationSource) task[`${kind}Source`] = verificationSource;
      task.evidence.push(event.id);
      plan.updatedAt = nowIso();
      assertValidPlan(plan, id, { requireContent: true });
      await atomicWriteJson(paths.plan, plan);
    } else if (stage !== null) {
      const stages = item.verification.stages || (item.verification.stages = []);
      let entry = stages.find((candidate) => candidate.stage === stage);
      if (!entry) {
        entry = { stage, status, evidence: [], command: null };
        stages.push(entry);
      } else {
        entry.status = status;
      }
      entry.evidence.push(event.id);
      entry.revision = event.revision;
      if (verificationSource) {
        entry.source = verificationSource;
        entry.planDigest = event.planDigest;
      }
      // 命令证据 id 只存 stage.command，不混入 evidence[]（保持 evidence[] 全为 verification-kind）。
      if (isRunBackedStage(stage)) entry.command = commandRef;
      // 顶层同时收录，使既有门禁的 nonEmptyStrings(verification.evidence) 与引用校验成立。
      item.verification.evidence.push(event.id);
      item.verification.status = aggregateVerificationStatus(stages, requiredVerificationStages(item));
      if (verificationSource) item.verification.source = verificationSource;
    } else if (kind !== "checkpoint") {
      item[kind].status = status;
      item[kind].evidence.push(event.id);
      if (kind === "review") item.review.independent = Boolean(independent);
      if (verificationSource) item[kind].source = verificationSource;
    }
    if (status === "fail" && kind === "verification") {
      item.review = { status: "pending", evidence: [], independent: false };
      item.acceptance = { status: "pending", evidence: [] };
      item.delivery = null;
    }
    if (status === "fail" && kind === "review") {
      item.acceptance = { status: "pending", evidence: [] };
      item.delivery = null;
    }
    item.updatedAt = nowIso();
    assertValidWorkItem(item);
    await atomicWriteJson(paths.state, item);
    return event;
  });
}

export async function addAnalysisConclusion(root, id, { status, text, evidence = [], unknown = null }) {
  return mutateWorkItem(root, id, async (item, paths) => {
    invariant(item.type === "ANALYSIS" && item.status === "ANALYZING", "WRONG_STAGE", "分析结论只能在 ANALYZING 阶段记录。" );
    invariant(["PROVEN", "INFERRED", "PROPOSAL", "UNKNOWN"].includes(status), "INVALID_CONCLUSION_STATUS", `无效结论状态：${status}`);
    invariant(text?.trim(), "CONCLUSION_REQUIRED", "结论不能为空。" );
    invariant(status === "UNKNOWN" || (Array.isArray(evidence) && evidence.length > 0), "EVIDENCE_REQUIRED", `${status} 结论必须提供证据。`);
    const conclusion = { id: randomUUID(), status, text, evidence };
    item.analysis.conclusions.push(conclusion);
    if (unknown?.trim()) item.analysis.unknowns.push(unknown);
    await appendEvent(paths, id, "analysis-conclusion-added", { conclusion });
    return conclusion;
  });
}

export async function validateWorkItem(root, id) {
  const item = await loadWorkItem(root, id);
  const plan = await loadPlan(root, id, { optional: true });
  return collectProgressErrors(root, item, plan);
}

export async function workItemLockStatus(root, id) {
  const paths = await workItemPaths(root, id);
  invariant(await exists(paths.state), "WORK_ITEM_NOT_FOUND", "工作项不存在。" );
  return { id, ...await inspectLock(paths.lock) };
}

export async function recoverWorkItemLock(root, id, { token, reason }) {
  invariant(reason?.trim(), "RECOVERY_REASON_REQUIRED", "恢复必须说明实际中断原因。" );
  const paths = await workItemPaths(root, id);
  invariant(await exists(paths.state), "WORK_ITEM_NOT_FOUND", "工作项不存在。" );
  const recovered = await recoverLock(paths.lock, token, async owner => {
    const errors = [];
    try {
      for (const file of [paths.events, paths.evidence]) {
        const raw = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
        if (raw && !raw.endsWith("\n")) errors.push(`${path.basename(file)} 缺少完整行结束，保留原文件。`);
        for (const line of raw.split(/\r?\n/).filter(line => line.trim())) {
          const entry = JSON.parse(line);
          if (!entry || entry.workItemId !== id || typeof entry.id !== "string") errors.push(`${path.basename(file)} 存在归属或结构异常。`);
        }
      }
      const item = await loadWorkItem(root, id), plan = await loadPlan(root, id, { optional: true });
      errors.push(...await collectProgressErrors(root, item, plan, { allowStale: true }));
      const { collectEvidenceErrors } = await import("./checker.mjs");
      errors.push(...await collectEvidenceErrors(root, item, plan));
    } catch (error) { errors.push(`${error.code || "INVALID_STATE"}: ${error.message}`); }
    invariant(errors.length === 0, "LOCK_STATE_INCONSISTENT", "控制面不完整，已保留原记录和恢复认领锁；没有追加事件或允许等待写入继续。", { errors });
    await appendEvent(paths, id, "lock-recovered", { reason, owner });
  });
  return { id, recovered: recovered.recovered, owner: recovered.owner, ok: true, errors: [], note: "已恢复锁；未修改状态、计划或验证结论，仍需按 guide 核实当前源码和验证。" };
}

export async function reopenWorkItem(root, id, { reason, replan = false, approvalRef = null }) {
  invariant(reason?.trim(), "REOPEN_REASON_REQUIRED", "返工必须说明原因。" );
  const paths = await workItemPaths(root, id);
  return withFileLock(paths.lock, async () => {
    const item = await readJson(paths.state);
    const plan = await readJson(paths.plan);
    assertValidWorkItem(item);
    invariant(isDevelopmentType(item.type) && ["IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"].includes(item.status), "WRONG_STAGE", "只能对已进入实施的开发工作返工。" );
    invariant(item.authorization.mode === "autonomous" || approvalRef?.trim(), "REOPEN_APPROVAL_REQUIRED", "此工作项返工需要实际批准引用。" );
    const revision = item.revision || 1;
    await atomicWriteJson(path.join(paths.directory, "revisions", `${revision}-state.json`), item);
    await atomicWriteJson(path.join(paths.directory, "revisions", `${revision}-plan.json`), plan);
    const from = item.status;
    if (from === "DONE" && item.delivery) {
      item.baseline.repository.source = item.delivery.source;
      item.baseline.completedAt = item.delivery.at;
    }
    item.revision = revision + 1;
    item.integrityVersion = 1;
    invalidateResults(item, plan);
    item.documentation = { status: "pending", evidence: [] };
    item.blocked = null;
    item.status = replan ? "SOLUTION_DESIGN" : "IMPLEMENTING";
    for (const task of plan.tasks) {
      task.status = task.blockedBy.length ? "PENDING" : "READY";
      task.verificationStatus = "pending";
      task.reviewStatus = "pending";
      task.evidence = [];
      task.deferralApproval = null;
      delete task.verificationSource;
      delete task.reviewSource;
    }
    plan.revision = item.revision;
    if (replan) {
      item.plan.approved = false;
      item.plan.approvalRef = null;
    }
    item.updatedAt = nowIso();
    plan.updatedAt = item.updatedAt;
    item.history.push({ from, to: item.status, at: item.updatedAt, reason, action: replan ? "replan" : "reopen", revision: item.revision });
    assertValidWorkItem(item);
    assertValidPlan(plan, id, { requireContent: !replan });
    await atomicWriteJson(paths.plan, plan);
    await atomicWriteJson(paths.state, item);
    await appendEvent(paths, id, replan ? "work-item-replanned" : "work-item-reopened", { from, to: item.status, reason, revision: item.revision, approvalRef: approvalRef || item.authorization.source });
    return item;
  });
}

export async function editTask(root, id, taskId, changes) {
  return mutatePlan(root, id, async (plan, item, paths) => {
    invariant(!item.plan.approved && ["SOLUTION_DESIGN", "DATABASE_DESIGN"].includes(item.status), "PLAN_LOCKED", "先通过 replan 保存旧计划并解除批准，再修改任务。" );
    const index = plan.tasks.findIndex((task) => task.id === taskId);
    invariant(index >= 0, "TASK_NOT_FOUND", `任务不存在：${taskId}`);
    const updated = createTask({ ...plan.tasks[index], ...changes, id: taskId });
    plan.tasks[index] = updated;
    for (const task of plan.tasks) task.blocks = [];
    for (const task of plan.tasks) for (const parentId of task.blockedBy) {
      const parent = plan.tasks.find((candidate) => candidate.id === parentId);
      invariant(parent, "DEPENDENCY_NOT_FOUND", `依赖不存在：${parentId}`);
      parent.blocks.push(task.id);
    }
    for (const batch of plan.reviewBatches) batch.taskIds = plan.tasks.filter((task) => task.reviewBatch === batch.id).map((task) => task.id);
    await appendEvent(paths, id, "task-definition-updated", { taskId, revision: item.revision });
    return updated;
  });
}
