import path from "node:path";
import { writeFile } from "node:fs/promises";
import { checkProject, doctorProject } from "./checker.mjs";
import { isRunBackedStage, requiredVerificationStages } from "./constants.mjs";
import { invariant } from "./errors.mjs";
import { exists, resolveProjectPath } from "./filesystem.mjs";
import { createPlan, createReviewBatch, createTask, createWorkItem } from "./model.mjs";
import { assertValidPlan, assertValidWorkItem } from "./validator.mjs";
import { assertCommandEvidence, assertVerification, readEvidence } from "./verification.mjs";
import {
  addReviewBatch, addTask, approvePlan, completeBaseline, completeSolution,
  createWorkItemState, initializePlan, loadPlan, loadWorkItem, recordResult,
  setDatabaseDecision, transitionWorkItem, updateTaskStatus, workItemPaths,
} from "./workflow.mjs";

function assertCompactEligible(type, flags, authorizationMode, risk) {
  invariant(["ITERATION", "BUGFIX"].includes(type), "FULL_WORKFLOW_REQUIRED", "精简入口只支持 ITERATION 或 BUGFIX。其他类型使用 start。" );
  invariant(["low", "medium"].includes(risk), "FULL_WORKFLOW_REQUIRED", "精简入口必须明确 low 或 medium 风险；高风险使用完整流程。" );
  invariant((flags || []).every((flag) => flag === "frontend"), "FULL_WORKFLOW_REQUIRED", "数据库、API、跨端或多 AI 工作使用完整流程。" );
  invariant(authorizationMode === "autonomous", "AUTONOMOUS_AUTHORIZATION_REQUIRED", "精简入口需要任务范围内的自主执行授权；需逐步批准时使用完整流程。" );
}

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

export async function finishWorkItem(root, id, { commandIds, verification, review, documentation, acceptance, stageEvidence = [], stageCommands = [] }) {
  for (const [name, value] of Object.entries({ verification, review, documentation, acceptance })) {
    invariant(value?.trim(), "RESULT_REQUIRED", `finish 必须提供 ${name} 的实际结论。`);
  }
  invariant(Array.isArray(commandIds) && commandIds.length > 0 && commandIds.every((value) => typeof value === "string" && value.trim()), "COMMAND_EVIDENCE_REQUIRED", "finish 必须通过 --command 引用实际验证命令。" );
  const item = await loadWorkItem(root, id);
  const plan = await loadPlan(root, id);
  assertValidPlan(plan, id, { requireContent: true });
  invariant(item.status === "IMPLEMENTING", "WRONG_STAGE", "finish 只从 IMPLEMENTING 开始；中断后使用 show 和细粒度命令恢复。" );
  invariant(plan.mode === "single" && plan.tasks.length === 1 && plan.reviewBatches.length === 1, "FULL_WORKFLOW_REQUIRED", "finish 只支持单 AI、单任务、单审查批次。" );
  const task = plan.tasks[0];
  assertCompactEligible(item.type, item.flags, item.authorization.mode, task.risk);
  invariant(!plan.reviewBatches.some((batch) => batch.independentRequired || batch.risk === "high"), "FULL_WORKFLOW_REQUIRED", "需要独立复核的工作不能通过 finish 完成。" );
  invariant(item.database.impact === "none", "FULL_WORKFLOW_REQUIRED", "涉及数据库的工作使用完整流程。" );
  invariant(task.status === "IN_PROGRESS", "WRONG_TASK_STAGE", "finish 需要 IN_PROGRESS 任务。" );

  const requiredStages = requiredVerificationStages(item);
  const runStages = requiredStages.filter(isRunBackedStage);
  const stageSummaries = parseStageInput(stageEvidence, requiredStages, "--stage-evidence");
  const stageReferences = parseStageInput(stageCommands, runStages, "--stage-command");
  invariant(requiredStages.every((stage) => stageSummaries.has(stage)), "VERIFICATION_STAGE_REQUIRED", `finish 需要各阶段实际证据：${requiredStages.join(", ")}。`);
  invariant(runStages.every((stage) => stageReferences.has(stage)), "STAGE_RUN_REQUIRED", "复现与回归阶段必须通过 --stage-command 引用实际成功命令。" );
  const references = [...new Set([...commandIds, ...stageReferences.values()])];
  const events = await readEvidence(root, id);
  for (const reference of references) invariant(events.some((event) => event.id === reference && event.kind === "command" && event.taskId === task.id), "COMMAND_EVIDENCE_INVALID", "引用必须属于当前任务的真实命令。" );
  await assertVerification(root, item, plan, { taskId: task.id });
  for (const reference of references) await assertCommandEvidence(root, item, plan, reference, { taskId: task.id });

  const checked = await checkProject(root);
  invariant(checked.ok, "CHECK_FAILED", "工作项或写入范围检查失败，未记录完成结果。", { errors: checked.errors });
  const verificationSummary = `${verification}\n命令证据：${references.join(", ")}`;
  await recordResult(root, id, { taskId: task.id, kind: "verification", status: "pass", summary: verificationSummary });
  await updateTaskStatus(root, id, task.id, "IMPLEMENTED");
  await updateTaskStatus(root, id, task.id, "IN_REVIEW");
  await recordResult(root, id, { taskId: task.id, kind: "review", status: "pass", summary: review });
  await updateTaskStatus(root, id, task.id, "COMPLETED");
  await transitionWorkItem(root, id, "VERIFYING");
  if (requiredStages.length > 0) {
    for (const stage of requiredStages) {
      await recordResult(root, id, {
        kind: "verification", status: "pass", stage, summary: stageSummaries.get(stage),
        commandRef: stageReferences.get(stage) ?? null,
      });
    }
  } else {
    await recordResult(root, id, { kind: "verification", status: "pass", summary: verificationSummary });
  }
  await recordResult(root, id, { kind: "documentation", status: /^N\/A\s*:/i.test(documentation) ? "not-applicable" : "pass", summary: documentation });
  await transitionWorkItem(root, id, "CODE_REVIEW");
  await recordResult(root, id, { kind: "review", status: "pass", summary: review });
  await transitionWorkItem(root, id, "READY_FOR_ACCEPTANCE");
  await recordResult(root, id, { kind: "acceptance", status: "pass", summary: `${acceptance}\n授权来源：${item.authorization.source}` });
  const done = await transitionWorkItem(root, id, "DONE");
  return { id: done.id, status: done.status, taskId: task.id, verificationCommands: references };
}
