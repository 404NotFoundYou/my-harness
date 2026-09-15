import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { commandKey, compileChecks } from "./commands.mjs";
import { readJson, resolveProjectPath } from "./filesystem.mjs";
import { invariant } from "./errors.mjs";
import { sourceSnapshot, loadSnapshot } from "./snapshot.mjs";
import { isRunBackedStage, requiredVerificationStages } from "./constants.mjs";
import { assertArtifacts } from "./artifacts.mjs";

export function checksFor(task) {
  return task.checks || compileChecks(task.verification);
}

export function acceptanceCoverage(item, plan) {
  const checks = (plan?.tasks || []).flatMap(task => checksFor(task).map(check => ({ taskId: task.id, checkId: check.id, acceptance: check.acceptance || [] })));
  const entries = item.input.acceptance.map((text, index) => ({ id: `A${index + 1}`, text,
    checks: checks.filter(check => check.acceptance.includes(`A${index + 1}`)).map(({ taskId, checkId }) => ({ taskId, checkId })) }));
  const mapped = checks.some(check => check.acceptance.length);
  return { mode: mapped ? "explicit" : "unspecified", entries,
    missing: mapped ? entries.filter(entry => !entry.checks.length).map(entry => entry.id) : [],
    invalid: [...new Set(checks.flatMap(check => check.acceptance))].filter(id => !entries.some(entry => entry.id === id)),
    note: "这是检查与验收的声明对应，不证明测试语义覆盖；仍需审查实际断言。" };
}

export function assertAcceptanceCoverage(item, plan) {
  const coverage = acceptanceCoverage(item, plan);
  invariant(!coverage.missing.length && !coverage.invalid.length, "ACCEPTANCE_MAPPING_INCOMPLETE", "启用验收映射后必须覆盖所有验收项，且不能引用不存在的编号。", coverage);
}

export function planDigest(item, plan) {
  const definition = {
    id: item.id, type: item.type, revision: item.revision || 1, flags: item.flags,
    acceptance: item.input.acceptance, authorization: item.authorization,
    mode: plan.mode,
    tasks: plan.tasks.map((task) => ({
      id: task.id, title: task.title, owner: task.owner, risk: task.risk,
      blockedBy: task.blockedBy, writeScopes: task.writeScopes, docsImpact: task.docsImpact,
      checks: checksFor(task), reviewBatch: task.reviewBatch,
    })),
    reviewBatches: plan.reviewBatches,
  };
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

export async function readEvidence(root, id) {
  const config = await readJson(path.join(root, ".ai-harness/config.json"));
  const file = await resolveProjectPath(root, `${config.workItemsDirectory}/${id}/evidence.jsonl`);
  let raw;
  try { raw = await readFile(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return raw.split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let event;
    try { event = JSON.parse(line); } catch { invariant(false, "INVALID_EVIDENCE_JSONL", `证据第 ${index + 1} 行不是有效 JSON。`); }
    invariant(event.workItemId === id, "INVALID_EVIDENCE_OWNER", "证据归属与工作项不一致。" );
    return [event];
  });
}

export function matchingChecks(plan, taskId, command, args) {
  const key = commandKey(command, args);
  return plan.tasks.filter((task) => (!taskId || task.id === taskId) && task.status !== "DEFERRED")
    .flatMap((task) => checksFor(task).filter((check) => commandKey(check.command, check.args) === key).map((check) => ({ taskId: task.id, checkId: check.id })));
}

export function hasFailedReview(events, item, task = null) {
  return events.some((event) => event.kind === "review" && event.status === "fail" &&
    (event.revision || 1) === (item.revision || 1) && (event.taskId ?? null) === (task?.id ?? null) &&
    (!task || (event.taskAttempt || 1) === (task.attempt || 1)));
}

function stageIsCurrent(item, entry, current, digest, events) {
  const latest = events.findLast((event) => event.kind === "verification" && !event.taskId &&
    event.stage === entry?.stage && (event.revision || 1) === (item.revision || 1));
  return entry?.status === "pass" && entry.source?.digest === current.digest &&
    entry.revision === (item.revision || 1) && entry.planDigest === digest &&
    latest?.id === entry.evidence.at(-1) && latest.status === "pass" &&
    latest.source?.digest === current.digest && latest.planDigest === digest &&
    (!isRunBackedStage(entry.stage) || latest.commandRef === entry.command);
}

export async function verificationReport(root, item, plan, { taskId = null, snapshot = null, events = null } = {}) {
  const current = snapshot || await sourceSnapshot(root);
  const evidence = events || await readEvidence(root, item.id);
  const digest = planDigest(item, plan);
  const latest = new Map();
  for (const event of evidence) {
    if (event.kind !== "command" || (event.revision || 1) !== (item.revision || 1) || !event.command || (taskId && event.taskId !== taskId)) continue;
    const task = plan.tasks.find((candidate) => candidate.id === event.taskId);
    if (task && (event.taskAttempt || 1) !== (task.attempt || 1)) continue;
    latest.set(JSON.stringify([event.taskId, commandKey(event.command.executable, event.command.args)]), event);
  }
  let failed = [...latest.values()].filter((event) =>
    event.command.planDigest === digest &&
    (event.command.source?.digest === current.digest || event.command.sourceAfter?.digest === current.digest) &&
    event.status !== "pass");
  const successful = [...latest.values()].filter((event) =>
    event.status === "pass" && event.command.exitCode === 0 && !event.command.timedOut && !event.command.spawnError && !event.command.signal &&
    event.command.planDigest === digest && event.command.source?.digest === current.digest && event.command.sourceAfter?.digest === current.digest);
  const required = plan.tasks.filter((task) => (!taskId || task.id === taskId) && task.status !== "DEFERRED")
    .flatMap((task) => checksFor(task).map((check) => ({ taskId: task.id, ...check })));
  const positions = new Map(evidence.map((event, index) => [event.id, index]));
  failed = failed.filter((event) => !successful.some((later) => positions.get(later.id) > positions.get(event.id) &&
    commandKey(later.command.executable, later.command.args) === commandKey(event.command.executable, event.command.args) &&
    (!later.taskId || later.taskId === event.taskId)));
  const missing = required.filter((check) => !successful.some((event) =>
    commandKey(event.command.executable, event.command.args) === commandKey(check.command, check.args) &&
    (!event.taskId || event.taskId === check.taskId)));
  const missingStages = requiredVerificationStages(item).filter((name) =>
    !stageIsCurrent(item, item.verification.stages?.find((entry) => entry.stage === name), current, digest, evidence));
  return { ok: required.length > 0 && missing.length === 0 && failed.length === 0, current, planDigest: digest, successful, missing, failed, missingStages };
}

export async function assertVerification(root, item, plan, options = {}) {
  assertAcceptanceCoverage(item, plan);
  const report = await verificationReport(root, item, plan, options);
  invariant(report.ok, "VERIFICATION_NOT_CURRENT", "计划中的验证尚未针对当前代码全部通过，或存在新的失败。", {
    missing: report.missing.map((check) => ({ taskId: check.taskId, checkId: check.id, command: check.command, args: check.args })),
    failed: report.failed.map((event) => event.id),
  });
  for (const event of report.successful) {
    await loadSnapshot(root, event.command.source);
    await loadSnapshot(root, event.command.sourceAfter);
  }
  for (const event of await readEvidence(root, item.id)) {
    if ((event.revision || 1) === (item.revision || 1) && event.status === "pass") await assertArtifacts(root, item.id, event.artifacts);
  }
  return report;
}

export async function assertCommandEvidence(root, item, plan, commandId, options = {}) {
  const events = options.events || await readEvidence(root, item.id);
  const current = options.snapshot || await sourceSnapshot(root);
  const index = events.findIndex((candidate) => candidate.id === commandId);
  const event = events[index];
  const task = plan.tasks.find((candidate) => candidate.id === event?.taskId);
  const command = event?.command;
  const subsequentFailure = command && events.slice(index + 1).some((later) => later.kind === "command" && later.status !== "pass" &&
    (later.revision || 1) === (item.revision || 1) && (!later.taskId || later.taskId === event.taskId) &&
    (!later.taskId || (later.taskAttempt || 1) === (event.taskAttempt || 1)) &&
    commandKey(later.command.executable, later.command.args) === commandKey(command.executable, command.args));
  invariant(event?.kind === "command" && event.status === "pass" && command.exitCode === 0 && !command.timedOut && !command.spawnError && !command.signal &&
    (event.revision || 1) === (item.revision || 1) && (!task || (event.taskAttempt || 1) === (task.attempt || 1)) &&
    (!options.taskId || event.taskId === options.taskId) && command.planDigest === planDigest(item, plan) &&
    command.source?.digest === current.digest && command.sourceAfter?.digest === current.digest && !subsequentFailure &&
    matchingChecks(plan, event.taskId, command.executable, command.args).length > 0,
  "COMMAND_EVIDENCE_INVALID", "命令证据必须匹配计划验证、当前代码和计划版本，且没有随后失败。" );
  await loadSnapshot(root, event.command.source);
  await loadSnapshot(root, event.command.sourceAfter);
  return event;
}

export async function assertVerificationStages(root, item, plan, snapshot) {
  const events = await readEvidence(root, item.id);
  const report = await verificationReport(root, item, plan, { snapshot, events });
  invariant(report.missingStages.length === 0, "STALE_VERIFICATION_STAGE", "验证阶段必须对应同一代码和计划版本。", { missing: report.missingStages });
  for (const stage of item.verification.stages || []) {
    if (!requiredVerificationStages(item).includes(stage.stage)) continue;
    await loadSnapshot(root, stage.source);
    if (isRunBackedStage(stage.stage)) await assertCommandEvidence(root, item, plan, stage.command, { snapshot, events });
  }
}

export function invalidateResults(item, plan, taskId = null) {
  item.verification = { status: "pending", evidence: [], stages: [] };
  item.review = { status: "pending", evidence: [], independent: false };
  item.acceptance = { status: "pending", evidence: [] };
  item.delivery = null;
  if (taskId) {
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (task?.status === "IN_PROGRESS") {
      task.verificationStatus = "pending";
      task.reviewStatus = "pending";
    }
  }
}
