export const SCHEMA_VERSION = 1;

export const WORK_TYPES = Object.freeze([
  "NEW_PROJECT",
  "ITERATION",
  "BUGFIX",
  "ANALYSIS",
]);

export const DEVELOPMENT_TYPES = Object.freeze([
  "NEW_PROJECT",
  "ITERATION",
  "BUGFIX",
]);

export const WORK_STATUSES = Object.freeze([
  "INTAKE",
  "BASELINING",
  "SOLUTION_DESIGN",
  "DATABASE_DESIGN",
  "PLANNED",
  "IMPLEMENTING",
  "VERIFYING",
  "CODE_REVIEW",
  "READY_FOR_ACCEPTANCE",
  "DONE",
  "ANALYZING",
  "ANSWERED",
  "BLOCKED",
]);

export const TERMINAL_STATUSES = Object.freeze(["DONE", "ANSWERED"]);

export const TASK_STATUSES = Object.freeze([
  "PENDING",
  "READY",
  "IN_PROGRESS",
  "IMPLEMENTED",
  "IN_REVIEW",
  "REWORK",
  "COMPLETED",
  "BLOCKED",
  "DEFERRED",
]);

export const RESULT_STATUSES = Object.freeze([
  "pending",
  "pass",
  "fail",
  "blocked",
  "not-applicable",
]);

export const EVIDENCE_KINDS = Object.freeze([
  "command",
  "verification",
  "review",
  "acceptance",
  "analysis",
  "documentation",
  "checkpoint",
]);

export const CONCLUSION_STATUSES = Object.freeze([
  "PROVEN",
  "INFERRED",
  "PROPOSAL",
  "UNKNOWN",
]);

export const BASE_TRANSITIONS = Object.freeze({
  NEW_PROJECT: Object.freeze({
    INTAKE: ["BASELINING"],
    BASELINING: ["SOLUTION_DESIGN"],
    SOLUTION_DESIGN: ["DATABASE_DESIGN", "PLANNED"],
    DATABASE_DESIGN: ["PLANNED"],
    PLANNED: ["IMPLEMENTING"],
    IMPLEMENTING: ["VERIFYING"],
    VERIFYING: ["CODE_REVIEW"],
    CODE_REVIEW: ["READY_FOR_ACCEPTANCE"],
    READY_FOR_ACCEPTANCE: ["DONE"],
  }),
  ITERATION: Object.freeze({
    INTAKE: ["BASELINING"],
    BASELINING: ["SOLUTION_DESIGN"],
    SOLUTION_DESIGN: ["DATABASE_DESIGN", "PLANNED"],
    DATABASE_DESIGN: ["PLANNED"],
    PLANNED: ["IMPLEMENTING"],
    IMPLEMENTING: ["VERIFYING"],
    VERIFYING: ["CODE_REVIEW"],
    CODE_REVIEW: ["READY_FOR_ACCEPTANCE"],
    READY_FOR_ACCEPTANCE: ["DONE"],
  }),
  BUGFIX: Object.freeze({
    INTAKE: ["BASELINING"],
    BASELINING: ["SOLUTION_DESIGN"],
    SOLUTION_DESIGN: ["DATABASE_DESIGN", "PLANNED"],
    DATABASE_DESIGN: ["PLANNED"],
    PLANNED: ["IMPLEMENTING"],
    IMPLEMENTING: ["VERIFYING"],
    VERIFYING: ["CODE_REVIEW"],
    CODE_REVIEW: ["READY_FOR_ACCEPTANCE"],
    READY_FOR_ACCEPTANCE: ["DONE"],
  }),
  ANALYSIS: Object.freeze({
    INTAKE: ["BASELINING"],
    BASELINING: ["ANALYZING"],
    ANALYZING: ["ANSWERED"],
  }),
});

export const TASK_TRANSITIONS = Object.freeze({
  PENDING: ["READY", "BLOCKED", "DEFERRED"],
  READY: ["IN_PROGRESS", "BLOCKED", "DEFERRED"],
  IN_PROGRESS: ["IMPLEMENTED", "BLOCKED", "DEFERRED"],
  IMPLEMENTED: ["IN_REVIEW", "REWORK", "BLOCKED", "DEFERRED"],
  IN_REVIEW: ["COMPLETED", "REWORK", "BLOCKED", "DEFERRED"],
  REWORK: ["IN_PROGRESS", "BLOCKED", "DEFERRED"],
  BLOCKED: ["READY", "DEFERRED"],
  COMPLETED: [],
  DEFERRED: [],
});

export const POLICY_FLAGS = Object.freeze([
  "database",
  "frontend",
  "mobile",
  "api",
  "multi-agent",
  "codegen",
]);

// 验证流水线的有序子阶段。codegen/bugfix 表示该阶段是否属于对应流水线的必需集；
// requiredFlag 非 null 表示仅当工作项同时带该 flag 时才必需（browser 仅在 frontend 时强制）；
// runBacked 表示该阶段必须由一次 harness run 的通过命令证据支撑（reproduction/regression）。
export const VERIFICATION_STAGES = Object.freeze([
  Object.freeze({ stage: "static", codegen: true, bugfix: true, requiredFlag: null, runBacked: false }),
  Object.freeze({ stage: "sandbox", codegen: true, bugfix: true, requiredFlag: null, runBacked: false }),
  Object.freeze({ stage: "contract", codegen: true, bugfix: false, requiredFlag: null, runBacked: false }),
  Object.freeze({ stage: "eval", codegen: true, bugfix: false, requiredFlag: null, runBacked: false }),
  Object.freeze({ stage: "reproduction", codegen: false, bugfix: true, requiredFlag: null, runBacked: true }),
  Object.freeze({ stage: "regression", codegen: false, bugfix: true, requiredFlag: null, runBacked: true }),
  Object.freeze({ stage: "browser", codegen: true, bugfix: true, requiredFlag: "frontend", runBacked: false }),
]);

// 工作项是否走验证流水线：BUGFIX 类型或声明 codegen 标志。
export function usesVerificationPipeline(item) {
  return item?.type === "BUGFIX" || (Array.isArray(item?.flags) && item.flags.includes("codegen"));
}

// 某子阶段是否必须由一次 harness run 的通过命令证据支撑。
export function isRunBackedStage(stage) {
  return VERIFICATION_STAGES.some((entry) => entry.stage === stage && entry.runBacked);
}

// 给定工作项，返回其必需通过的子阶段名（有序）。按类型（BUGFIX）与 flags（codegen）取并集。
export function requiredVerificationStages(item) {
  const flags = Array.isArray(item?.flags) ? item.flags : [];
  const isBugfix = item?.type === "BUGFIX";
  const isCodegen = flags.includes("codegen");
  return VERIFICATION_STAGES
    .filter((stage) => {
      const applies = (isCodegen && stage.codegen) || (isBugfix && stage.bugfix);
      return applies && (stage.requiredFlag === null || flags.includes(stage.requiredFlag));
    })
    .map((stage) => stage.stage);
}

// 由已记录的子阶段聚合出 verification 顶层状态：任一必需阶段 fail 即 fail；
// 全部必需阶段 pass 才 pass；否则 pending。
export function aggregateVerificationStatus(stages = [], requiredStageNames = []) {
  const byName = new Map(stages.map((entry) => [entry.stage, entry.status]));
  if (requiredStageNames.some((name) => byName.get(name) === "fail")) return "fail";
  if (requiredStageNames.length > 0 && requiredStageNames.every((name) => byName.get(name) === "pass")) return "pass";
  return "pending";
}

export const WORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function nowIso() {
  return new Date().toISOString();
}

export function isDevelopmentType(type) {
  return DEVELOPMENT_TYPES.includes(type);
}
