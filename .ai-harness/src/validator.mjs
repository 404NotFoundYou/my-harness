import path from "node:path";
import {
  BASE_TRANSITIONS,
  CONCLUSION_STATUSES,
  POLICY_FLAGS,
  RESULT_STATUSES,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  WORK_ID_PATTERN,
  WORK_STATUSES,
  WORK_TYPES,
  isDevelopmentType,
} from "./constants.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import { resolveProjectPath } from "./filesystem.mjs";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim());
}

function validResult(result) {
  return isObject(result) && RESULT_STATUSES.includes(result.status) && Array.isArray(result.evidence);
}

function validGate(gate) {
  return (
    isObject(gate) &&
    ["pending", "complete", "not-applicable"].includes(gate.status) &&
    Array.isArray(gate.evidence) &&
    (gate.document === null || typeof gate.document === "string") &&
    (gate.completedAt === null || typeof gate.completedAt === "string")
  );
}

export function collectWorkItemShapeErrors(item) {
  const errors = [];
  if (!isObject(item)) return ["工作项必须是 JSON 对象。"];
  if (item.schemaVersion !== 1) errors.push("工作项 schemaVersion 必须为 1。");
  if (!WORK_ID_PATTERN.test(item.id || "")) errors.push("工作项 ID 格式无效。");
  if (!WORK_TYPES.includes(item.type)) errors.push(`未知工作类型：${item.type}`);
  if (typeof item.title !== "string" || !item.title.trim()) errors.push("工作项标题不能为空。");
  if (!WORK_STATUSES.includes(item.status)) errors.push(`未知工作项状态：${item.status}`);
  if (!Array.isArray(item.flags)) errors.push("flags 必须是数组。");
  else {
    if (item.flags.some((flag) => !POLICY_FLAGS.includes(flag))) errors.push("flags 包含未知策略标志。" );
    if (new Set(item.flags).size !== item.flags.length) errors.push("flags 不得重复。" );
  }
  if (!nonEmptyStrings(item.policyFiles)) errors.push("policyFiles 至少包含核心策略。" );
  if (!isObject(item.authorization) || !["autonomous", "approval-required"].includes(item.authorization.mode)) {
    errors.push("authorization.mode 必须为 autonomous 或 approval-required。");
  }
  if (!item.authorization?.source?.trim()) errors.push("authorization.source 不能为空。");
  if (!isObject(item.input)) errors.push("input 必须是对象。");
  if (!nonEmptyStrings(item.input?.references)) errors.push("input.references 至少需要一个权威输入。" );
  if (!nonEmptyStrings(item.input?.acceptance)) errors.push("input.acceptance 至少需要一个完成条件。" );
  if (!Array.isArray(item.input?.nonGoals)) errors.push("input.nonGoals 必须是数组。");
  if (!isObject(item.architecture) || !["HUMAN_PROVIDED", "AI_RECOMMENDED", null].includes(item.architecture?.source)) {
    errors.push("architecture 结构无效。" );
  }
  if (item.type === "NEW_PROJECT" && (!item.architecture?.source || !item.architecture?.approvalRef?.trim())) {
    errors.push("NEW_PROJECT 必须包含架构来源和批准引用。" );
  }
  if (item.bug !== null && (!isObject(item.bug) || !item.bug.actual?.trim() || !item.bug.expected?.trim() || !item.bug.reproduction?.trim())) {
    errors.push("bug 必须包含 actual、expected 和 reproduction。" );
  }
  if (item.type === "BUGFIX" && item.bug === null) errors.push("BUGFIX 必须包含复现基线。" );
  if (!validGate(item.baseline)) errors.push("baseline 结构无效。");
  if (!validGate(item.solution)) errors.push("solution 结构无效。");
  if (!validGate(item.database) || !["unknown", "none", "required"].includes(item.database?.impact)) {
    errors.push("database 结构或 impact 无效。");
  }
  if (!isObject(item.plan) || typeof item.plan.path !== "string" || typeof item.plan.approved !== "boolean") {
    errors.push("plan 结构无效。");
  }
  if (item.plan?.path !== `.ai-harness/work-items/${item.id}/plan.json`) errors.push("plan.path 与工作项 ID 不一致。" );
  for (const [name, result] of Object.entries({
    verification: item.verification,
    review: item.review,
    acceptance: item.acceptance,
    analysis: item.analysis,
    documentation: item.documentation,
  })) {
    if (!validResult(result)) errors.push(`${name} 结构无效。`);
  }
  if (typeof item.review?.independent !== "boolean") errors.push("review.independent 必须是布尔值。");
  if (!Array.isArray(item.analysis?.conclusions) || !Array.isArray(item.analysis?.unknowns)) {
    errors.push("analysis conclusions/unknowns 必须是数组。");
  }
  if (!Array.isArray(item.history) || item.history.length === 0) errors.push("history 至少包含创建事件。");
  if (typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") {
    errors.push("createdAt/updatedAt 必须是 ISO 时间字符串。");
  }
  return errors;
}

function scopePrefix(scope) {
  const normalized = scope.replaceAll("\\", "/").replace(/^\.\//, "");
  const wildcardIndex = normalized.search(/[?*\[]/);
  return (wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex)).replace(/\/+$/, "");
}

function scopeValid(scope) {
  if (typeof scope !== "string" || !scope.trim() || path.isAbsolute(scope)) return false;
  const normalized = scope.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === "." || normalized === "*" || normalized === "**" || normalized === "**/*") return false;
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return false;
  return scopePrefix(normalized).length > 0;
}

function scopesOverlap(left, right) {
  const a = scopePrefix(left);
  const b = scopePrefix(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function dependencyReachable(tasksById, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const task = tasksById.get(from);
  return task ? task.blocks.some((next) => dependencyReachable(tasksById, next, target, seen)) : false;
}

export function collectPlanErrors(plan, workItemId = null, { requireComplete = true } = {}) {
  const errors = [];
  if (!isObject(plan)) return ["计划必须是 JSON 对象。"];
  if (plan.schemaVersion !== 1) errors.push("计划 schemaVersion 必须为 1。");
  if (!WORK_ID_PATTERN.test(plan.workItemId || "")) errors.push("计划 workItemId 无效。");
  if (workItemId && plan.workItemId !== workItemId) errors.push("计划与工作项 ID 不一致。");
  if (!['single', 'multi'].includes(plan.mode)) errors.push("计划 mode 必须为 single 或 multi。");
  if (typeof plan.rationale !== "string" || !plan.rationale.trim()) errors.push("计划 rationale 不能为空。");
  if (!Array.isArray(plan.tasks)) errors.push("计划 tasks 必须是数组。");
  if (!Array.isArray(plan.reviewBatches)) errors.push("计划 reviewBatches 必须是数组。");
  if (errors.length > 0) return errors;

  const tasksById = new Map();
  for (const task of plan.tasks) {
    if (!isObject(task) || !WORK_ID_PATTERN.test(task.id || "")) {
      errors.push("任务 ID 无效。");
      continue;
    }
    if (tasksById.has(task.id)) errors.push(`重复任务 ID：${task.id}`);
    tasksById.set(task.id, task);
    if (!task.title?.trim()) errors.push(`${task.id} 标题不能为空。`);
    if (!task.module?.trim()) errors.push(`${task.id} module 不能为空。`);
    if (!TASK_STATUSES.includes(task.status)) errors.push(`${task.id} 状态无效：${task.status}`);
    if (!Array.isArray(task.blockedBy) || !Array.isArray(task.blocks)) errors.push(`${task.id} 依赖字段必须是数组。`);
    if (!nonEmptyStrings(task.writeScopes)) errors.push(`${task.id} 至少需要一个写入范围。`);
    else if (task.writeScopes.some((scope) => !scopeValid(scope))) errors.push(`${task.id} 包含过宽或越界写入范围。`);
    if (!nonEmptyStrings(task.verification)) errors.push(`${task.id} 至少需要一个验证方式。`);
    if (!nonEmptyStrings(task.docsImpact)) errors.push(`${task.id} 必须记录文档影响或 N/A: 理由。`);
    if (!task.reviewBatch?.trim()) errors.push(`${task.id} 必须属于 Review Batch。`);
    if (!['low', 'medium', 'high'].includes(task.risk)) errors.push(`${task.id} 风险等级无效。`);
    if (!task.owner?.trim()) errors.push(`${task.id} owner 不能为空。`);
    if (!RESULT_STATUSES.includes(task.verificationStatus)) errors.push(`${task.id} verificationStatus 无效。`);
    if (!RESULT_STATUSES.includes(task.reviewStatus)) errors.push(`${task.id} reviewStatus 无效。`);
    if (!Array.isArray(task.evidence)) errors.push(`${task.id} evidence 必须是数组。`);
    if (["IMPLEMENTED", "IN_REVIEW", "COMPLETED"].includes(task.status) && task.verificationStatus !== "pass") {
      errors.push(`${task.id} 在 ${task.status} 前必须通过任务验证。`);
    }
    if (task.status === "COMPLETED" && task.reviewStatus !== "pass") {
      errors.push(`${task.id} 标记 COMPLETED 前必须通过 Code Review。`);
    }
    if (task.status === "DEFERRED" && !task.deferralApproval?.trim()) {
      errors.push(`${task.id} 延期缺少有权批准记录。`);
    }
  }

  for (const task of plan.tasks) {
    for (const dependency of task.blockedBy || []) {
      if (!tasksById.has(dependency)) errors.push(`${task.id} 依赖不存在：${dependency}`);
      if (dependency === task.id) errors.push(`${task.id} 不能依赖自身。`);
      const parent = tasksById.get(dependency);
      if (parent && !parent.blocks.includes(task.id)) errors.push(`${dependency}.blocks 缺少 ${task.id}。`);
    }
    for (const blocked of task.blocks || []) {
      if (!tasksById.has(blocked)) errors.push(`${task.id} blocks 指向不存在任务：${blocked}`);
      const child = tasksById.get(blocked);
      if (child && !child.blockedBy.includes(task.id)) errors.push(`${blocked}.blockedBy 缺少 ${task.id}。`);
    }
    if (["READY", "IN_PROGRESS", "IMPLEMENTED", "IN_REVIEW", "COMPLETED"].includes(task.status)) {
      const incomplete = (task.blockedBy || []).filter((id) => !["COMPLETED", "DEFERRED"].includes(tasksById.get(id)?.status));
      if (incomplete.length > 0) errors.push(`${task.id} 已解锁但依赖未完成：${incomplete.join(", ")}`);
    }
  }

  for (const task of plan.tasks) {
    if (dependencyReachable(tasksById, task.id, task.id, new Set(["__start__"]))) {
      const actualCycle = task.blocks.some((next) => dependencyReachable(tasksById, next, task.id));
      if (actualCycle) errors.push(`任务依赖存在环：${task.id}`);
    }
  }

  const batchesById = new Map();
  const membership = new Map();
  for (const batch of plan.reviewBatches) {
    if (!isObject(batch) || !WORK_ID_PATTERN.test(batch.id || "")) {
      errors.push("Review Batch ID 无效。");
      continue;
    }
    if (batchesById.has(batch.id)) errors.push(`重复 Review Batch：${batch.id}`);
    batchesById.set(batch.id, batch);
    if (!batch.title?.trim()) errors.push(`${batch.id} 标题不能为空。`);
    if (!['low', 'medium', 'high'].includes(batch.risk)) errors.push(`${batch.id} 风险无效。`);
    if (!Array.isArray(batch.taskIds) || (requireComplete && batch.taskIds.length === 0)) errors.push(`${batch.id} 必须包含任务。`);
    if (typeof batch.independentRequired !== "boolean") errors.push(`${batch.id} independentRequired 必须是布尔值。`);
    if (batch.risk === "high" && !batch.independentRequired) errors.push(`${batch.id} 为高风险，必须要求独立复核。`);
    for (const taskId of batch.taskIds || []) {
      if (!tasksById.has(taskId)) errors.push(`${batch.id} 包含不存在任务：${taskId}`);
      if (membership.has(taskId)) errors.push(`${taskId} 同时属于多个 Review Batch。`);
      membership.set(taskId, batch.id);
    }
  }
  for (const task of plan.tasks) {
    if (!batchesById.has(task.reviewBatch)) errors.push(`${task.id} 的 Review Batch 不存在：${task.reviewBatch}`);
    if (membership.get(task.id) !== task.reviewBatch) errors.push(`${task.id} 与 Review Batch 成员关系不一致。`);
    const batch = batchesById.get(task.reviewBatch);
    if (task.risk === "high" && batch && !batch.independentRequired) {
      errors.push(`${task.id} 为高风险，Review Batch 必须要求独立复核。`);
    }
  }

  if (plan.mode === "multi") {
    if (requireComplete && plan.tasks.length < 2) errors.push("multi 计划至少需要两个任务。" );
    if (requireComplete && new Set(plan.tasks.map((task) => task.owner)).size < 2) errors.push("multi 计划至少需要两个不同所有者。" );
    for (let leftIndex = 0; leftIndex < plan.tasks.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < plan.tasks.length; rightIndex += 1) {
        const left = plan.tasks[leftIndex];
        const right = plan.tasks[rightIndex];
        const ordered = dependencyReachable(tasksById, left.id, right.id) || dependencyReachable(tasksById, right.id, left.id);
        if (!ordered && left.writeScopes.some((a) => right.writeScopes.some((b) => scopesOverlap(a, b)))) {
          errors.push(`并行任务写入范围重叠：${left.id} 与 ${right.id}`);
        }
      }
    }
  }

  return [...new Set(errors)];
}

export function assertValidWorkItem(item) {
  const errors = collectWorkItemShapeErrors(item);
  if (errors.length > 0) throw new HarnessError("INVALID_WORK_ITEM", "工作项结构校验失败。", { errors });
}

export function assertValidPlan(plan, workItemId = null, { requireContent = false } = {}) {
  const errors = collectPlanErrors(plan, workItemId, { requireComplete: requireContent });
  if (requireContent && plan.tasks?.length === 0) errors.push("计划至少需要一个任务。监控/纯咨询应使用 ANALYSIS，而不是空开发计划。");
  if (requireContent && plan.reviewBatches?.length === 0) errors.push("计划至少需要一个 Review Batch。");
  if (errors.length > 0) throw new HarnessError("INVALID_PLAN", "计划校验失败。", { errors });
}

export function fileMatchesScope(file, scope) {
  const normalizedFile = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalizedScope = scope.replaceAll("\\", "/").replace(/^\.\//, "");
  let pattern = "^";
  for (let index = 0; index < normalizedScope.length; index += 1) {
    const character = normalizedScope[index];
    if (character === "*" && normalizedScope[index + 1] === "*") {
      pattern += ".*";
      index += 1;
    } else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  pattern += "$";
  return new RegExp(pattern).test(normalizedFile);
}

export function assertTransitionAllowed(item, target, reason = null) {
  assertValidWorkItem(item);
  invariant(WORK_STATUSES.includes(target), "UNKNOWN_STATUS", `未知目标状态：${target}`);
  invariant(!TERMINAL_STATUSES.includes(item.status), "TERMINAL_STATE", `${item.status} 是终态，不能继续转换。`);

  if (target === "BLOCKED") {
    invariant(item.status !== "BLOCKED", "ALREADY_BLOCKED", "工作项已经处于 BLOCKED。" );
    invariant(typeof reason === "string" && reason.trim(), "BLOCK_REASON_REQUIRED", "进入 BLOCKED 必须提供原因。" );
    return;
  }

  if (item.status === "BLOCKED") {
    invariant(item.blocked?.from === target, "INVALID_UNBLOCK", `解除阻塞只能返回 ${item.blocked?.from || "原状态"}。`);
    return;
  }

  const allowed = BASE_TRANSITIONS[item.type]?.[item.status] || [];
  invariant(allowed.includes(target), "INVALID_TRANSITION", `不允许 ${item.type} 从 ${item.status} 转到 ${target}。`, {
    allowed,
  });
}

async function assertEvidenceDocument(root, gate, name, { documentRequired = false } = {}) {
  invariant(gate.status === "complete" || gate.status === "not-applicable", "GATE_INCOMPLETE", `${name} 尚未完成。`);
  invariant(nonEmptyStrings(gate.evidence), "GATE_EVIDENCE_REQUIRED", `${name} 缺少证据。`);
  if (documentRequired) {
    invariant(gate.document?.trim(), "GATE_DOCUMENT_REQUIRED", `${name} 缺少文档路径。`);
    await resolveProjectPath(root, gate.document, { mustExist: true });
  }
}

export async function assertTransitionGates(root, item, plan, target) {
  if (target === "BLOCKED" || item.status === "BLOCKED") return;
  if (target === "BASELINING") {
    invariant(nonEmptyStrings(item.input.references), "INPUT_REQUIRED", "工作项至少需要一个权威输入或问题引用。" );
    invariant(nonEmptyStrings(item.input.acceptance), "ACCEPTANCE_REQUIRED", "工作项至少需要一个可判定完成条件。" );
    if (item.type === "NEW_PROJECT") {
      invariant(["HUMAN_PROVIDED", "AI_RECOMMENDED"].includes(item.architecture.source), "ARCHITECTURE_SOURCE_REQUIRED", "新项目必须明确架构来源。" );
      invariant(item.architecture.approvalRef?.trim(), "ARCHITECTURE_APPROVAL_REQUIRED", "新项目架构必须提供批准/授权引用。" );
    }
    if (item.type === "BUGFIX") {
      invariant(item.bug?.actual?.trim() && item.bug?.expected?.trim() && item.bug?.reproduction?.trim(), "BUG_BASELINE_REQUIRED", "BUGFIX 必须提供实际行为、期望行为和复现路径。" );
    }
    return;
  }
  if (["SOLUTION_DESIGN", "ANALYZING"].includes(target)) {
    await assertEvidenceDocument(root, item.baseline, "基线");
    invariant(isObject(item.baseline.repository), "REPOSITORY_BASELINE_REQUIRED", "基线缺少仓库状态。" );
    return;
  }
  if (target === "DATABASE_DESIGN") {
    await assertEvidenceDocument(root, item.solution, "技术设计", { documentRequired: true });
    invariant(item.database.impact === "required", "DATABASE_IMPACT_MISMATCH", "只有数据库影响 required 才能进入 DATABASE_DESIGN。" );
    return;
  }
  if (target === "PLANNED") {
    await assertEvidenceDocument(root, item.solution, "技术设计", { documentRequired: true });
    invariant(item.database.impact !== "unknown", "DATABASE_DECISION_REQUIRED", "计划前必须完成数据库影响判断。" );
    if (item.database.impact === "required") {
      await assertEvidenceDocument(root, item.database, "数据库设计", { documentRequired: true });
    } else {
      await assertEvidenceDocument(root, item.database, "数据库不适用结论");
    }
    invariant(plan, "PLAN_REQUIRED", "进入 PLANNED 前必须创建执行计划。" );
    assertValidPlan(plan, item.id, { requireContent: true });
    invariant(item.plan.approved && item.plan.approvalRef?.trim(), "PLAN_APPROVAL_REQUIRED", "计划必须有批准或端到端授权记录。" );
    return;
  }
  if (target === "IMPLEMENTING") {
    invariant(plan, "PLAN_REQUIRED", "实现前缺少计划。" );
    assertValidPlan(plan, item.id, { requireContent: true });
    invariant(item.plan.approved, "PLAN_APPROVAL_REQUIRED", "实现前计划必须批准。" );
    return;
  }
  if (target === "VERIFYING") {
    invariant(plan, "PLAN_REQUIRED", "验证前缺少计划。" );
    assertValidPlan(plan, item.id, { requireContent: true });
    const unfinished = plan.tasks.filter((task) => !["COMPLETED", "DEFERRED"].includes(task.status));
    invariant(unfinished.length === 0, "TASKS_UNFINISHED", "仍有任务未完成或未获批准延期。", {
      tasks: unfinished.map((task) => `${task.id}:${task.status}`),
    });
    return;
  }
  if (target === "CODE_REVIEW") {
    invariant(item.verification.status === "pass" && nonEmptyStrings(item.verification.evidence), "FINAL_VERIFICATION_REQUIRED", "工作项验证尚未通过。" );
    invariant(["pass", "not-applicable"].includes(item.documentation.status) && nonEmptyStrings(item.documentation.evidence), "DOCUMENTATION_REQUIRED", "文档同步尚未确认。" );
    return;
  }
  if (target === "READY_FOR_ACCEPTANCE") {
    invariant(item.review.status === "pass" && nonEmptyStrings(item.review.evidence), "FINAL_REVIEW_REQUIRED", "工作项最终 Code Review 尚未通过。" );
    const independentRequired = plan?.reviewBatches?.some((batch) => batch.independentRequired) || false;
    invariant(!independentRequired || item.review.independent, "INDEPENDENT_REVIEW_REQUIRED", "高风险批次需要独立复核证据。" );
    return;
  }
  if (target === "DONE") {
    invariant(item.acceptance.status === "pass" && nonEmptyStrings(item.acceptance.evidence), "ACCEPTANCE_REQUIRED", "DONE 前缺少有权验收证据。" );
    return;
  }
  if (target === "ANSWERED") {
    invariant(item.type === "ANALYSIS", "TYPE_MISMATCH", "只有 ANALYSIS 可以进入 ANSWERED。" );
    invariant(item.analysis.status === "pass", "ANALYSIS_INCOMPLETE", "分析回答尚未标记通过。" );
    invariant(item.analysis.conclusions.length > 0, "ANALYSIS_CONCLUSION_REQUIRED", "至少需要一个带状态的分析结论。" );
    for (const conclusion of item.analysis.conclusions) {
      invariant(CONCLUSION_STATUSES.includes(conclusion.status), "ANALYSIS_STATUS_INVALID", "分析结论状态无效。", { conclusion });
      invariant(conclusion.text?.trim(), "ANALYSIS_TEXT_REQUIRED", "分析结论不能为空。" );
      if (conclusion.status !== "UNKNOWN") {
        invariant(nonEmptyStrings(conclusion.evidence), "ANALYSIS_EVIDENCE_REQUIRED", `${conclusion.status} 结论缺少证据。`);
      }
    }
  }
}

export function collectHistoryErrors(item) {
  const errors = [];
  if (!Array.isArray(item.history) || item.history.length === 0) return ["状态历史为空。"];
  let previous = null;
  for (let index = 0; index < item.history.length; index += 1) {
    const entry = item.history[index];
    if (entry.from !== previous) errors.push(`history[${index}] from 与前一状态不一致。`);
    if (!WORK_STATUSES.includes(entry.to)) errors.push(`history[${index}] 目标状态无效。`);
    if (entry.to !== "BLOCKED" && entry.from !== "BLOCKED" && entry.from !== null) {
      const allowed = BASE_TRANSITIONS[item.type]?.[entry.from] || [];
      if (!allowed.includes(entry.to)) errors.push(`history[${index}] 包含非法转换 ${entry.from} -> ${entry.to}。`);
    }
    if (entry.to === "BLOCKED" && !entry.reason?.trim()) errors.push(`history[${index}] 阻塞缺少原因。`);
    if (entry.from === "BLOCKED" && entry.to !== entry.unblockedTo) errors.push(`history[${index}] 解除阻塞目标记录无效。`);
    previous = entry.to;
  }
  if (previous !== item.status) errors.push("当前状态与历史最后状态不一致。");
  return errors;
}

export async function collectProgressErrors(root, item, plan) {
  const errors = [...collectWorkItemShapeErrors(item), ...collectHistoryErrors(item)];
  if (item.status === "BLOCKED") return [...new Set(errors)];
  const addGateError = async (target) => {
    try {
      await assertTransitionGates(root, item, plan, target);
    } catch (error) {
      errors.push(`${target}: ${error.message}`);
      if (error.details?.errors) errors.push(...error.details.errors.map((detail) => `${target}: ${detail}`));
    }
  };

  if (item.type === "ANALYSIS") {
    if (["ANALYZING", "ANSWERED"].includes(item.status)) await addGateError("ANALYZING");
    if (item.status === "ANSWERED") await addGateError("ANSWERED");
    return [...new Set(errors)];
  }

  const reached = (statuses) => statuses.includes(item.status);
  if (reached(["SOLUTION_DESIGN", "DATABASE_DESIGN", "PLANNED", "IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"])) {
    await addGateError("SOLUTION_DESIGN");
  }
  if (reached(["PLANNED", "IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"])) {
    await addGateError("PLANNED");
  }
  if (reached(["IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"])) await addGateError("IMPLEMENTING");
  if (reached(["VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"])) await addGateError("VERIFYING");
  if (reached(["CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"])) await addGateError("CODE_REVIEW");
  if (reached(["READY_FOR_ACCEPTANCE", "DONE"])) await addGateError("READY_FOR_ACCEPTANCE");
  if (item.status === "DONE") await addGateError("DONE");
  return [...new Set(errors)];
}

export function taskDependenciesComplete(plan, task) {
  const byId = new Map(plan.tasks.map((candidate) => [candidate.id, candidate]));
  return task.blockedBy.every((id) => ["COMPLETED", "DEFERRED"].includes(byId.get(id)?.status));
}

export function assertTaskTransition(plan, task, target, approvalRef = null) {
  invariant(TASK_STATUSES.includes(target), "UNKNOWN_TASK_STATUS", `未知任务状态：${target}`);
  const allowed = {
    PENDING: ["READY", "BLOCKED", "DEFERRED"],
    READY: ["IN_PROGRESS", "BLOCKED", "DEFERRED"],
    IN_PROGRESS: ["IMPLEMENTED", "BLOCKED", "DEFERRED"],
    IMPLEMENTED: ["IN_REVIEW", "REWORK", "BLOCKED", "DEFERRED"],
    IN_REVIEW: ["COMPLETED", "REWORK", "BLOCKED", "DEFERRED"],
    REWORK: ["IN_PROGRESS", "BLOCKED", "DEFERRED"],
    BLOCKED: ["READY", "DEFERRED"],
  }[task.status] || [];
  invariant(allowed.includes(target), "INVALID_TASK_TRANSITION", `不允许 ${task.id} 从 ${task.status} 转到 ${target}。`, { allowed });
  if (["READY", "IN_PROGRESS"].includes(target)) {
    invariant(taskDependenciesComplete(plan, task), "TASK_DEPENDENCY_BLOCKED", `${task.id} 的依赖尚未完成。`);
  }
  if (target === "IMPLEMENTED") {
    invariant(task.verificationStatus === "pass", "TASK_VERIFICATION_REQUIRED", `${task.id} 在 IMPLEMENTED 前必须通过任务验证。`);
  }
  if (target === "COMPLETED") {
    invariant(task.verificationStatus === "pass", "TASK_VERIFICATION_REQUIRED", `${task.id} 缺少验证。`);
    invariant(task.reviewStatus === "pass", "TASK_REVIEW_REQUIRED", `${task.id} 缺少 Code Review。`);
  }
  if (target === "DEFERRED") {
    invariant(typeof approvalRef === "string" && approvalRef.trim(), "DEFERRAL_APPROVAL_REQUIRED", `${task.id} 延期必须提供有权批准记录。`);
  }
}
