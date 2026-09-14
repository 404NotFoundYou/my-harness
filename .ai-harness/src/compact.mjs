import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { checkProject, doctorProject } from "./checker.mjs";
import { invariant } from "./errors.mjs";
import { exists, resolveProjectPath } from "./filesystem.mjs";
import { createPlan, createReviewBatch, createTask, createWorkItem } from "./model.mjs";
import { assertValidPlan, assertValidWorkItem } from "./validator.mjs";
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
  return { id: item.id, status: item.status, taskId: task.id, policyFiles: item.policyFiles, document };
}

export async function finishWorkItem(root, id, { commandIds, verification, review, documentation, acceptance }) {
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

  const checked = await checkProject(root);
  invariant(checked.ok, "CHECK_FAILED", "工作项或写入范围检查失败，未记录完成结果。", { errors: checked.errors });
  const paths = await workItemPaths(root, id);
  const raw = (await exists(paths.evidence)) ? await readFile(paths.evidence, "utf8") : "";
  const events = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const commands = events.filter((event) => event.kind === "command" && event.workItemId === id && event.taskId === task.id);
  const latest = new Map();
  for (const event of commands) {
    latest.set(JSON.stringify([event.command?.executable, event.command?.args]), event);
  }
  const passed = (event) => event.status === "pass" && event.command?.exitCode === 0 && event.command.policy?.decision === "allow" && !event.command.timedOut && !event.command.spawnError && !event.command.signal;
  invariant([...latest.values()].every(passed), "VERIFICATION_FAILED", "存在最新一次执行仍失败的命令，必须修复并重新验证。" );
  const selected = commandIds.map((reference) => commands.find((event) => event.id === reference));
  invariant(selected.every((event) => event && passed(event) && [...latest.values()].includes(event)), "COMMAND_EVIDENCE_INVALID", "命令证据必须属于当前任务、执行成功且是该命令最新一次结果。" );
  const history = (await readFile(paths.events, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const started = history.findLast((event) => event.action === "task-transition" && event.taskId === task.id && event.to === "IN_PROGRESS");
  invariant(started && selected.every((event) => event.timestamp >= started.timestamp), "COMMAND_EVIDENCE_STALE", "返工后必须重新运行验证，不能复用前一次实现的命令。" );

  const verificationSummary = `${verification}\n命令证据：${[...new Set(commandIds)].join(", ")}`;
  await recordResult(root, id, { taskId: task.id, kind: "verification", status: "pass", summary: verificationSummary });
  await updateTaskStatus(root, id, task.id, "IMPLEMENTED");
  await updateTaskStatus(root, id, task.id, "IN_REVIEW");
  await recordResult(root, id, { taskId: task.id, kind: "review", status: "pass", summary: review });
  await updateTaskStatus(root, id, task.id, "COMPLETED");
  await transitionWorkItem(root, id, "VERIFYING");
  await recordResult(root, id, { kind: "verification", status: "pass", summary: verificationSummary });
  await recordResult(root, id, { kind: "documentation", status: /^N\/A\s*:/i.test(documentation) ? "not-applicable" : "pass", summary: documentation });
  await transitionWorkItem(root, id, "CODE_REVIEW");
  await recordResult(root, id, { kind: "review", status: "pass", summary: review });
  await transitionWorkItem(root, id, "READY_FOR_ACCEPTANCE");
  await recordResult(root, id, { kind: "acceptance", status: "pass", summary: `${acceptance}\n授权来源：${item.authorization.source}` });
  const done = await transitionWorkItem(root, id, "DONE");
  return { id: done.id, status: done.status, taskId: task.id, verificationCommands: [...new Set(commandIds)] };
}
