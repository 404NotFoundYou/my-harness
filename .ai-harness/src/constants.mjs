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
]);

export const WORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function nowIso() {
  return new Date().toISOString();
}

export function isDevelopmentType(type) {
  return DEVELOPMENT_TYPES.includes(type);
}
