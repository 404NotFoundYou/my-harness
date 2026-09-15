import { invariant } from "./errors.mjs";
import { requiredVerificationStages, usesVerificationPipeline } from "./constants.mjs";

function compactConstraint(type, flags, authorizationMode, risk) {
  if (!["ITERATION", "BUGFIX"].includes(type)) return ["FULL_WORKFLOW_REQUIRED", "精简入口只支持 ITERATION 或 BUGFIX。其他类型使用 start。"];
  if (!["low", "medium"].includes(risk)) return ["FULL_WORKFLOW_REQUIRED", "精简入口必须明确 low 或 medium 风险；高风险使用完整流程。"];
  if (!(flags || []).every(flag => flag === "frontend")) return ["FULL_WORKFLOW_REQUIRED", "数据库、API、跨端或多 AI 工作使用完整流程。"];
  if (authorizationMode !== "autonomous") return ["AUTONOMOUS_AUTHORIZATION_REQUIRED", "精简入口需要任务范围内的自主执行授权；需逐步批准时使用完整流程。"];
  return null;
}

export function assertCompactEligible(type, flags, authorizationMode, risk) {
  const error = compactConstraint(type, flags, authorizationMode, risk);
  if (error) invariant(false, ...error);
}

export function completionRequirements(item, plan) {
  const task = plan?.tasks?.[0];
  if (!task || compactConstraint(item.type, item.flags, item.authorization.mode, task.risk) ||
    plan.mode !== "single" || plan.tasks.length !== 1 || plan.reviewBatches.length !== 1 ||
    plan.reviewBatches.some(batch => batch.independentRequired || batch.risk === "high") || item.database.impact !== "none" ||
    !["IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"].includes(item.status) ||
    !["IN_PROGRESS", "IMPLEMENTED", "IN_REVIEW", "COMPLETED"].includes(task.status)) return null;
  if (item.status === "DONE") return { fields: [], stages: [] };
  const fields = [];
  if (task.verificationStatus !== "pass" || (!usesVerificationPipeline(item) && item.verification.status !== "pass")) fields.push("verification");
  if (task.reviewStatus !== "pass" || item.review.status !== "pass") fields.push("review");
  if (!["pass", "not-applicable"].includes(item.documentation.status)) fields.push("documentation");
  if (item.acceptance.status !== "pass") fields.push("acceptance");
  return { fields, stages: requiredVerificationStages(item).filter(name => !item.verification.stages?.some(entry => entry.stage === name && entry.status === "pass")) };
}

export function completionSourcesCurrent(item, plan, snapshot) {
  const task = plan.tasks[0];
  const results = [
    ...["verification", "review"].map(kind => ({ status: task[`${kind}Status`], source: task[`${kind}Source`] })),
    item.verification, item.review, item.acceptance, ...(item.verification.stages || []),
  ];
  return results.every(result => result.status !== "pass" || result.source?.digest === snapshot.digest);
}
