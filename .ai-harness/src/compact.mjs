import path from "node:path";
import { writeFile } from "node:fs/promises";
import { checkProject, doctorProject } from "./checker.mjs";
import { isRunBackedStage, requiredVerificationStages } from "./constants.mjs";
import { invariant } from "./errors.mjs";
import { exists, resolveProjectPath } from "./filesystem.mjs";
import { createPlan, createReviewBatch, createTask, createWorkItem } from "./model.mjs";
import { assertValidPlan, assertValidWorkItem } from "./validator.mjs";
import { assertAcceptanceCoverage, assertCommandEvidence, assertVerification, hasFailedReview, matchingChecks, readEvidence, verificationReport } from "./verification.mjs";
import { loadSnapshot } from "./snapshot.mjs";
import { assertCompactEligible, completionRequirements, completionSourcesCurrent } from "./completion.mjs";
import { normalizeDocumentation } from "./input.mjs";
import {
  addReviewBatch, addTask, approvePlan, completeBaseline, completeSolution,
  createWorkItemState, initializePlan, loadPlan, loadWorkItem, recordResult,
  setDatabaseDecision, transitionWorkItem, updateTaskStatus, validateWorkItem, workItemPaths,
} from "./workflow.mjs";

function parseStageInput(entries, allowed, option) {
  invariant(Array.isArray(entries), "STAGE_INPUT_INVALID", `${option} 必须是 stage=value 数组。`);
  const values = new Map();
  for (const entry of entries) {
    const separator = typeof entry === "string" ? entry.indexOf("=") : -1;
    invariant(separator > 0, "STAGE_INPUT_INVALID", `${option} 格式必须为 stage=value。`);
    const stage = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    invariant(allowed.includes(stage) && value && !values.has(stage), "STAGE_INPUT_INVALID", `${option} 包含不适用、重复或空的阶段：${stage}`);
    values.set(stage, value);
  }
  return values;
}

export async function beginWorkItem(root, options) {
  assertCompactEligible(options.type, options.flags, options.authorizationMode, options.risk);
  invariant(options.approach?.trim(), "APPROACH_REQUIRED", "必须提供简短实施方案。" );
  invariant(options.databaseEvidence?.trim(), "DATABASE_EVIDENCE_REQUIRED", "必须提供无数据库影响的依据；有影响时使用完整流程。" );
  assertValidWorkItem(createWorkItem(options));
  const batch = { id: "R1", title: options.title, risk: options.risk, independentRequired: false };
  const task = {
    id: "T1", title: options.title, module: "compact", owner: "primary-ai",
    writeScopes: options.writeScopes, verification: options.verification,
    docsImpact: options.docsImpact, risk: options.risk, reviewBatch: batch.id,
  };
  const planOptions = { workItemId: options.id, mode: "single", rationale: options.approach };
  const preview = createPlan(planOptions);
  preview.tasks.push(createTask(task));
  preview.reviewBatches.push({ ...createReviewBatch(batch), taskIds: [task.id] });
  assertValidPlan(preview, options.id, { requireContent: true });
  assertAcceptanceCoverage(createWorkItem(options), preview);
  const health = await doctorProject(root);
  invariant(health.ok, "DOCTOR_FAILED", "Runtime 检查失败，未创建工作项。", { errors: health.errors });
  invariant(health.details.repository.commit, "GIT_COMMIT_REQUIRED", "精简入口需要已有 Git 提交以记录基线。" );
  const paths = await workItemPaths(root, options.id);
  const document = path.relative(root, path.join(paths.directory, "solution.md")).replaceAll("\\", "/");
  const documentPath = await resolveProjectPath(root, document, { forWrite: true });
  invariant(!(await exists(documentPath)), "SOLUTION_EXISTS", "工作项方案文件已存在；使用 show 检查并恢复，不能覆盖。" );

  await createWorkItemState(root, options);
  await transitionWorkItem(root, options.id, "BASELINING");
  await completeBaseline(root, options.id, { evidence: options.references });
  await transitionWorkItem(root, options.id, "SOLUTION_DESIGN");
  await writeFile(documentPath, `# ${options.title}\n\n${options.approach}\n\n数据库无影响依据：${options.databaseEvidence}\n`, { encoding: "utf8", flag: "wx" });
  await completeSolution(root, options.id, { document, evidence: [options.approach] });
  await setDatabaseDecision(root, options.id, { impact: "none", evidence: [options.databaseEvidence] });
  await initializePlan(root, options.id, planOptions);
  await addReviewBatch(root, options.id, batch);
  await addTask(root, options.id, task);
  await approvePlan(root, options.id, options.authorizationSource);
  await transitionWorkItem(root, options.id, "PLANNED");
  const item = await transitionWorkItem(root, options.id, "IMPLEMENTING");
  await updateTaskStatus(root, options.id, task.id, "IN_PROGRESS");
  return { id: item.id, status: item.status, taskId: task.id, policyFiles: item.policyFiles, document,
    guide: { executable: "node", args: [".ai-harness/bin/harness.mjs", "guide", "--id", item.id, "--task", task.id, "--json"] },
  };
}

export async function finishWorkItem(root, id, { commandIds = [], verification, review, documentation, acceptance, stageEvidence = [], stageCommands = [] } = {}) {
  let item = await loadWorkItem(root, id);
  let plan = await loadPlan(root, id);
  assertValidPlan(plan, id, { requireContent: true });
  invariant(plan.mode === "single" && plan.tasks.length === 1 && plan.reviewBatches.length === 1, "FULL_WORKFLOW_REQUIRED", "finish 只支持单 AI、单任务、单审查批次。" );
  let task = plan.tasks[0];
  assertCompactEligible(item.type, item.flags, item.authorization.mode, task.risk);
  invariant(!plan.reviewBatches.some(batch => batch.independentRequired || batch.risk === "high") && item.database.impact === "none", "FULL_WORKFLOW_REQUIRED", "该工作需要完整流程或独立复核。" );
  const requirements = completionRequirements(item, plan);
  invariant(requirements, "WRONG_TASK_STAGE", "finish 需要已进入实施或合法收尾阶段的任务；先用 guide 确认下一步。" );
  if (item.status === "DONE") {
    const errors = await validateWorkItem(root, id);
    invariant(errors.length === 0, "CHECK_FAILED", "已完成工作项的冻结证据无效。", { errors });
    const report = item.delivery ? await verificationReport(root, item, plan, { snapshot: await loadSnapshot(root, item.delivery.source) }) : null;
    return { id, status: "DONE", taskId: task.id, alreadyDone: true, verificationCommands: report?.successful.filter(event => matchingChecks(plan, event.taskId, event.command.executable, event.command.args).length).map(event => event.id) || [] };
  }
  const results = { verification, review, documentation: normalizeDocumentation(documentation), acceptance };
  for (const name of requirements.fields) invariant(typeof results[name] === "string" && results[name].trim(), "RESULT_REQUIRED", `finish 尚缺 ${name} 的实际结论。已完成的结论无需重复提交。`, { required: requirements.fields });
  invariant(Array.isArray(commandIds) && commandIds.every(value => typeof value === "string" && value.trim()), "COMMAND_EVIDENCE_REQUIRED", "command 必须是命令证据 ID 数组。" );
  const stages = requiredVerificationStages(item);
  const stageSummaries = parseStageInput(stageEvidence, stages, "--stage-evidence");
  const stageReferences = parseStageInput(stageCommands, stages.filter(isRunBackedStage), "--stage-command");
  invariant(requirements.stages.every(stage => stageSummaries.has(stage)), "VERIFICATION_STAGE_REQUIRED", `finish 尚缺阶段的实际证据：${requirements.stages.join(", ")}。`);
  invariant(requirements.stages.filter(isRunBackedStage).every(stage => stageReferences.has(stage)), "STAGE_RUN_REQUIRED", "未完成的复现/回归阶段必须引用实际成功命令。" );
  const events = await readEvidence(root, id);
  invariant(!hasFailedReview(events, item, task) && !hasFailedReview(events, item), "REVIEW_REWORK_REQUIRED", "审查失败后必须先按 REWORK/reopen 建立新尝试或修订。" );
  const proofOptions = { taskId: item.status === "IMPLEMENTING" ? task.id : null };
  const references = [...new Set([...commandIds, ...stageReferences.values()])];
  for (const reference of references) invariant(events.some(event => event.id === reference && event.kind === "command" && (event.taskId === task.id || (!event.taskId && item.status !== "IMPLEMENTING"))), "COMMAND_EVIDENCE_INVALID", "引用必须属于当前任务的真实命令。" );
  const report = await assertVerification(root, item, plan, proofOptions);
  if (!references.length) references.push(...report.successful.filter(event => matchingChecks(plan, event.taskId, event.command.executable, event.command.args).length).map(event => event.id));
  for (const reference of references) await assertCommandEvidence(root, item, plan, reference, proofOptions);
  invariant(completionSourcesCurrent(item, plan, report.current), "STALE_COMPLETION", "已有通过结论不对应当前代码；请正常返工和重新审查，不能直接续用。" );
  const checked = await checkProject(root);
  invariant(checked.ok, "CHECK_FAILED", "工作项或写入范围检查失败，未记录完成结果。", { errors: checked.errors });
  const verificationSummary = `${results.verification}\n命令证据：${references.join(", ")}`;
  while (item.status !== "DONE") {
    if (item.status === "IMPLEMENTING") {
      if (task.status === "IN_PROGRESS") {
        if (task.verificationStatus !== "pass") await recordResult(root, id, { taskId: task.id, kind: "verification", status: "pass", summary: verificationSummary });
        await updateTaskStatus(root, id, task.id, "IMPLEMENTED");
      } else if (task.status === "IMPLEMENTED") await updateTaskStatus(root, id, task.id, "IN_REVIEW");
      else if (task.status === "IN_REVIEW") {
        if (task.reviewStatus !== "pass") await recordResult(root, id, { taskId: task.id, kind: "review", status: "pass", summary: results.review });
        await updateTaskStatus(root, id, task.id, "COMPLETED");
      } else await transitionWorkItem(root, id, "VERIFYING");
    } else if (item.status === "VERIFYING") {
      const stage = stages.find(name => !item.verification.stages?.some(entry => entry.stage === name && entry.status === "pass"));
      if (stage) await recordResult(root, id, { kind: "verification", status: "pass", stage, summary: stageSummaries.get(stage), commandRef: stageReferences.get(stage) ?? null });
      else if (!stages.length && item.verification.status !== "pass") await recordResult(root, id, { kind: "verification", status: "pass", summary: verificationSummary });
      else if (!["pass", "not-applicable"].includes(item.documentation.status)) await recordResult(root, id, { kind: "documentation", status: results.documentation.startsWith("N/A:") ? "not-applicable" : "pass", summary: results.documentation });
      else await transitionWorkItem(root, id, "CODE_REVIEW");
    } else if (item.status === "CODE_REVIEW") {
      if (item.review.status !== "pass") await recordResult(root, id, { kind: "review", status: "pass", summary: results.review });
      else await transitionWorkItem(root, id, "READY_FOR_ACCEPTANCE");
    } else if (item.status === "READY_FOR_ACCEPTANCE") {
      if (item.acceptance.status !== "pass") await recordResult(root, id, { kind: "acceptance", status: "pass", summary: `${results.acceptance}\n授权来源：${item.authorization.source}` });
      else await transitionWorkItem(root, id, "DONE");
    } else invariant(false, "WRONG_STAGE", "工作项状态已变化，停止收尾并重新读取 guide。" );
    item = await loadWorkItem(root, id);
    plan = await loadPlan(root, id);
    task = plan.tasks[0];
  }
  return { id, status: "DONE", taskId: task.id, verificationCommands: references };
}
