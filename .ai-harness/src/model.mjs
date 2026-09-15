import { SCHEMA_VERSION, nowIso } from "./constants.mjs";
import { compileChecks } from "./commands.mjs";
import { normalizeDocumentation } from "./input.mjs";

function pendingGate(extra = {}) {
  return {
    status: "pending",
    document: null,
    evidence: [],
    completedAt: null,
    ...extra,
  };
}

function pendingResult(extra = {}) {
  return {
    status: "pending",
    evidence: [],
    ...extra,
  };
}

export function createWorkItem({
  id,
  type,
  title,
  references,
  acceptance,
  nonGoals = [],
  version = null,
  authorizationMode,
  authorizationSource,
  flags = [],
  policyFiles = [".ai-harness/policies/core.md"],
  architectureSource = null,
  architectureApproval = null,
  bug = null,
}) {
  const timestamp = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    policyRoutingVersion: 2,
    integrityVersion: 1,
    revision: 1,
    id,
    type,
    title,
    status: "INTAKE",
    flags,
    policyFiles,
    authorization: {
      mode: authorizationMode,
      source: authorizationSource,
    },
    input: {
      references,
      acceptance,
      nonGoals,
      version,
    },
    architecture: {
      source: architectureSource,
      approvalRef: architectureApproval,
    },
    bug,
    baseline: pendingGate({ repository: null }),
    solution: pendingGate(),
    database: pendingGate({ impact: "unknown" }),
    plan: {
      path: `.ai-harness/work-items/${id}/plan.json`,
      approved: false,
      approvalRef: null,
    },
    verification: pendingResult({ stages: [] }),
    review: pendingResult({ independent: false }),
    acceptance: pendingResult(),
    analysis: pendingResult({ conclusions: [], unknowns: [] }),
    documentation: pendingResult(),
    blocked: null,
    delivery: null,
    history: [
      {
        from: null,
        to: "INTAKE",
        at: timestamp,
        reason: "work-item-created",
      },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createPlan({ workItemId, mode, rationale }) {
  const timestamp = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    workItemId,
    mode,
    rationale,
    tasks: [],
    reviewBatches: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createTask({
  id,
  title,
  module,
  blockedBy = [],
  writeScopes,
  verification,
  docsImpact,
  reviewBatch,
  risk,
  owner,
}) {
  return {
    id,
    title,
    module,
    status: blockedBy.length === 0 ? "READY" : "PENDING",
    attempt: 0,
    blockedBy: [...new Set(blockedBy)],
    blocks: [],
    writeScopes: [...new Set(writeScopes)],
    verification: [...new Set(verification)],
    checks: compileChecks([...new Set(verification)]),
    docsImpact: [...new Set(docsImpact.map(normalizeDocumentation))],
    reviewBatch,
    risk,
    owner,
    verificationStatus: "pending",
    reviewStatus: "pending",
    evidence: [],
    deferralApproval: null,
  };
}

export function createReviewBatch({ id, title, risk, independentRequired }) {
  return {
    id,
    title,
    risk,
    taskIds: [],
    independentRequired,
  };
}
