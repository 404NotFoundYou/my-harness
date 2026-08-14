import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { EVIDENCE_KINDS, RESULT_STATUSES, TERMINAL_STATUSES } from "./constants.mjs";
import { changedFilesSince, fileFingerprint, getGitBaseline } from "./git.mjs";
import { exists, readJson } from "./filesystem.mjs";
import { inspectManagedBlock, normalizeManagedBody } from "./managed-block.mjs";
import { collectPlanErrors, fileMatchesScope } from "./validator.mjs";
import { loadConfig, loadPlan, loadWorkItem, validateWorkItem, workItemPaths } from "./workflow.mjs";

function parseVersion(value) {
  return String(value)
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(current, minimum) {
  const left = parseVersion(current);
  const right = parseVersion(minimum);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] || 0) > (right[index] || 0)) return true;
    if ((left[index] || 0) < (right[index] || 0)) return false;
  }
  return true;
}

function containsLine(content, expected) {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => line.trim() === expected);
}

export async function doctorProject(root, { requireInitialized = true } = {}) {
  const errors = [];
  const warnings = [];
  const details = {};
  let manifest;
  let config;
  try {
    manifest = await readJson(path.join(root, ".ai-harness", "manifest.json"));
    details.harnessVersion = manifest.version;
    if (!versionAtLeast(process.versions.node, manifest.minimumNodeVersion)) {
      errors.push(`Node.js ${process.versions.node} 低于最低版本 ${manifest.minimumNodeVersion}。`);
    }
  } catch (error) {
    errors.push(error.message);
  }
  try {
    config = await loadConfig(root);
    if (config.schemaVersion !== 1) errors.push("config.json schemaVersion 必须为 1。");
  } catch (error) {
    errors.push(error.message);
  }

  details.instructionFiles = {};
  for (const [relative, expectedImport] of [
    ["AGENTS.md", null],
    ["CLAUDE.md", "@AGENTS.md"],
    ["GEMINI.md", "@./AGENTS.md"],
  ]) {
    try {
      const content = await readFile(path.join(root, relative), "utf8");
      const canonical = await readFile(path.join(root, ".ai-harness", "templates", "instructions", relative), "utf8");
      const inspection = inspectManagedBlock(content, relative);
      if (inspection.present) {
        if (!inspection.hashValid) errors.push(`${relative} 的 Harness 托管块哈希无效。`);
        if (manifest && inspection.version !== manifest.version) {
          errors.push(`${relative} 的托管块版本 ${inspection.version} 与 Runtime ${manifest.version} 不一致。`);
        }
        if (normalizeManagedBody(inspection.body) !== normalizeManagedBody(canonical)) {
          errors.push(`${relative} 的托管块内容不是当前 Runtime 标准载荷。`);
        }
        details.instructionFiles[relative] = { mode: "managed", version: inspection.version, hashValid: inspection.hashValid };
      } else if (expectedImport) {
        if (!containsLine(content, expectedImport)) errors.push(`${relative} 缺少兼容导入行 ${expectedImport}。`);
        details.instructionFiles[relative] = { mode: "compatible-existing", version: null, hashValid: null };
      } else {
        details.instructionFiles[relative] = { mode: "legacy", version: null, hashValid: null };
      }
    } catch (error) {
      errors.push(`${relative} 无法读取：${error.message}`);
    }
  }

  try {
    const agentsPath = path.join(root, "AGENTS.md");
    const info = await stat(agentsPath);
    details.rootInstructionsBytes = info.size;
    if (config && info.size > config.rootInstructionsMaxBytes) {
      errors.push(`AGENTS.md 为 ${info.size} 字节，超过 ${config.rootInstructionsMaxBytes} 字节上限。`);
    }
    const agents = await readFile(agentsPath, "utf8");
    if (!agents.includes(".ai-harness/bin/harness.mjs")) errors.push("AGENTS.md 未声明 runtime CLI 入口。" );
    if (!agents.includes("policies")) errors.push("AGENTS.md 未声明专项策略路由。" );
  } catch (error) {
    errors.push(`AGENTS.md 无法检查：${error.message}`);
  }

  try {
    const policyIndex = await readJson(path.join(root, ".ai-harness", manifest?.policyIndex || "policies/index.json"));
    const references = new Set([
      ...(policyIndex.always || []),
      ...Object.values(policyIndex.byType || {}).flat(),
      ...Object.values(policyIndex.byFlag || {}).flat(),
    ]);
    for (const reference of references) {
      if (!(await exists(path.join(root, ".ai-harness", "policies", reference)))) {
        errors.push(`策略索引引用不存在文件：${reference}`);
      }
    }
    details.policyCount = references.size;
  } catch (error) {
    errors.push(`策略索引无法检查：${error.message}`);
  }

  const projectPath = path.join(root, ".ai-harness", "project.json");
  if (!(await exists(projectPath))) {
    const message = "项目尚未执行 harness init。";
    if (requireInitialized) errors.push(message);
    else warnings.push(message);
  } else {
    try {
      const project = await readJson(projectPath);
      if (project.schemaVersion !== 1 || !["new", "existing"].includes(project.mode)) errors.push("project.json 结构无效。" );
      details.projectMode = project.mode;
    } catch (error) {
      errors.push(error.message);
    }
  }

  const repository = await getGitBaseline(root);
  details.repository = {
    isGit: repository.isGit,
    branch: repository.branch,
    commit: repository.commit,
    dirty: repository.dirty,
    changedFiles: repository.changedFiles,
  };
  if (config?.requireGit && !repository.isGit) errors.push("config.json 要求 Git，但项目不是 Git 仓库。" );
  return { ok: errors.length === 0, errors, warnings, details };
}

async function workItemIds(root, config) {
  const directory = path.join(root, config.workItemsDirectory);
  if (!(await exists(directory))) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function stateRequiresCompletePlan(status) {
  return ["PLANNED", "IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"].includes(status);
}

function expectedPolicyFiles(index, item) {
  const names = new Set([...(index.always || []), ...(index.byType?.[item.type] || [])]);
  for (const flag of item.flags) for (const name of index.byFlag?.[flag] || []) names.add(name);
  return [...names].map((name) => `.ai-harness/policies/${name}`);
}

function plannedScopes(item, plan) {
  if (!plan) return [];
  const scopes = new Set([`.ai-harness/work-items/${item.id}/**`]);
  for (const task of plan.tasks) {
    for (const scope of task.writeScopes) scopes.add(scope);
    for (const impact of task.docsImpact) {
      if (!/^N\/A\s*:/i.test(impact)) scopes.add(impact);
    }
  }
  return [...scopes];
}

async function collectScopeErrors(root, records) {
  const errors = [];
  const warnings = [];
  const changed = new Set();
  const scopes = new Set();
  const initialFingerprints = new Map();
  for (const { item, plan } of records) {
    for (const scope of plannedScopes(item, plan)) scopes.add(scope);
    const baseline = item.baseline.repository;
    if (!baseline?.isGit) continue;
    const result = await changedFilesSince(root, baseline.commit);
    if (result.warning) warnings.push(`${item.id}: ${result.warning}`);
    for (const file of result.files) changed.add(file);
    for (const [file, fingerprint] of Object.entries(baseline.fingerprints || {})) {
      if (!initialFingerprints.has(file)) initialFingerprints.set(file, new Set());
      initialFingerprints.get(file).add(fingerprint);
    }
  }

  for (const file of [...changed]) {
    const initial = initialFingerprints.get(file);
    if (initial) {
      const current = await fileFingerprint(root, file);
      if (initial.has(current)) continue;
    }
    if (![...scopes].some((scope) => fileMatchesScope(file, scope))) {
      errors.push(`Git 差异超出所有活动工作项写入范围：${file}`);
    }
  }
  return { errors, warnings, changedFiles: [...changed].sort(), scopes: [...scopes].sort() };
}

async function collectEvidenceErrors(root, item, plan) {
  const errors = [];
  const paths = await workItemPaths(root, item.id);
  let raw = "";
  try {
    raw = await readFile(paths.evidence, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const events = [];
  const byId = new Map();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      errors.push(`evidence.jsonl:${index + 1} 不是有效 JSON：${error.message}`);
      continue;
    }
    if (event.schemaVersion !== 1 || !event.id?.trim() || event.workItemId !== item.id) {
      errors.push(`evidence.jsonl:${index + 1} 基本结构或 workItemId 无效。`);
      continue;
    }
    if (!EVIDENCE_KINDS.includes(event.kind) || !event.summary?.trim() || !event.timestamp?.trim()) {
      errors.push(`evidence.jsonl:${index + 1} kind、summary 或 timestamp 无效。`);
    }
    if (event.kind !== "command" && !RESULT_STATUSES.includes(event.status)) {
      errors.push(`evidence.jsonl:${index + 1} 结果状态无效。`);
    }
    if (byId.has(event.id)) errors.push(`evidence.jsonl 包含重复 ID：${event.id}`);
    byId.set(event.id, event);
    events.push(event);
  }

  const assertReferences = (references, { kind, taskId = null, label }) => {
    for (const reference of references) {
      const event = byId.get(reference);
      if (!event) {
        errors.push(`${label} 引用不存在的证据：${reference}`);
        continue;
      }
      if (event.kind !== kind || (event.taskId ?? null) !== taskId) {
        errors.push(`${label} 证据类型或 taskId 不匹配：${reference}`);
      }
    }
  };

  for (const kind of ["verification", "review", "acceptance", "analysis", "documentation"]) {
    const result = item[kind];
    assertReferences(result.evidence, { kind, label: `工作项 ${kind}` });
    const latest = events.findLast((event) => event.kind === kind && (event.taskId ?? null) === null);
    if (result.status !== "pending" && (!latest || latest.status !== result.status)) {
      errors.push(`工作项 ${kind} 状态与最新证据不一致。`);
    }
    if (kind === "review" && latest && Boolean(latest.independent) !== result.independent) {
      errors.push("工作项 review 的独立复核标记与最新证据不一致。");
    }
  }

  for (const task of plan?.tasks || []) {
    for (const reference of task.evidence) {
      const event = byId.get(reference);
      if (!event) {
        errors.push(`任务 ${task.id} 引用不存在的证据：${reference}`);
      } else if (event.taskId !== task.id || !["verification", "review"].includes(event.kind)) {
        errors.push(`任务 ${task.id} 的证据类型或 taskId 不匹配：${reference}`);
      }
    }
    for (const [kind, statusField] of [["verification", "verificationStatus"], ["review", "reviewStatus"]]) {
      const latest = events.findLast((event) => event.taskId === task.id && event.kind === kind);
      if (task[statusField] !== "pending" && (!latest || latest.status !== task[statusField])) {
        errors.push(`任务 ${task.id} 的 ${statusField} 与最新证据不一致。`);
      }
    }
  }
  return errors;
}

export async function checkProject(root, { ci = false } = {}) {
  const doctor = await doctorProject(root, { requireInitialized: true });
  const errors = [...doctor.errors];
  const warnings = [...doctor.warnings];
  const config = await loadConfig(root);
  const policyIndex = await readJson(path.join(root, ".ai-harness", "policies", "index.json"));
  const records = [];
  const items = [];
  for (const id of await workItemIds(root, config)) {
    try {
      const item = await loadWorkItem(root, id);
      items.push(item);
      const expectedPolicies = expectedPolicyFiles(policyIndex, item);
      if (JSON.stringify(item.policyFiles) !== JSON.stringify(expectedPolicies)) {
        errors.push(`${id}: policyFiles 与工作类型/flags 的确定性路由不一致。`);
      }
      const plan = await loadPlan(root, id, { optional: true });
      const progressErrors = await validateWorkItem(root, id);
      errors.push(...progressErrors.map((message) => `${id}: ${message}`));
      const evidenceErrors = await collectEvidenceErrors(root, item, plan);
      errors.push(...evidenceErrors.map((message) => `${id}: ${message}`));
      if (plan) {
        const planErrors = collectPlanErrors(plan, id, { requireComplete: item.plan.approved || stateRequiresCompletePlan(item.status) });
        errors.push(...planErrors.map((message) => `${id}: ${message}`));
      }
      if (["IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"].includes(item.status)) {
        records.push({ item, plan });
      }
    } catch (error) {
      errors.push(`${id}: ${error.message}`);
      if (error.details?.errors) errors.push(...error.details.errors.map((message) => `${id}: ${message}`));
    }
  }
  const scope = await collectScopeErrors(root, records);
  errors.push(...scope.errors);
  warnings.push(...scope.warnings);
  if (ci) {
    const incomplete = items.filter((item) => !TERMINAL_STATUSES.includes(item.status));
    if (incomplete.length > 0) {
      errors.push(`CI 不接受未完成工作项：${incomplete.map((item) => `${item.id}:${item.status}`).join(", ")}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    details: {
      ...doctor.details,
      workItems: await workItemIds(root, config),
      changedFiles: scope.changedFiles,
      allowedScopes: scope.scopes,
    },
  };
}
