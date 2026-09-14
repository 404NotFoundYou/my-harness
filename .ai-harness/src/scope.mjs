import path from "node:path";
import { readdir } from "node:fs/promises";
import { readJson } from "./filesystem.mjs";
import { commitSnapshot, controlPath, loadSnapshot, makeSnapshot, snapshotChanges, sourceSnapshot } from "./snapshot.mjs";
import { fileFingerprint, gitResult } from "./git.mjs";
import { fileMatchesScope } from "./validator.mjs";
import { planDigest } from "./verification.mjs";
import { invariant } from "./errors.mjs";

export function plannedScopes(item, plan) {
  return [...new Set((plan?.tasks || []).flatMap((task) => [...task.writeScopes, ...task.docsImpact.filter((entry) => !/^N\/A\s*:/i.test(entry))]))];
}

function ownedChanges(baseline, source, scopes) {
  return snapshotChanges(baseline, source).filter((file) => scopes.some((scope) => fileMatchesScope(file, scope)))
    .map((file) => ({ path: file, before: baseline.files[file] ?? null, after: source.files[file] ?? null }));
}

async function baselineSnapshot(root, item, current, config) {
  if (item.baseline.repository?.source) return loadSnapshot(root, item.baseline.repository.source);
  const baseline = await commitSnapshot(root, item.baseline.repository.commit);
  for (const [file, fingerprint] of Object.entries(item.baseline.repository.fingerprints || {})) {
    if (controlPath(file, config.workItemsDirectory)) continue;
    if (await fileFingerprint(root, file) === fingerprint) {
      if (current.files[file]) baseline.files[file] = current.files[file];
      else delete baseline.files[file];
    }
  }
  return makeSnapshot(baseline.files);
}

async function legacyArchive(root, item, config) {
  const relative = `${config.workItemsDirectory}/${item.id}/state.json`;
  const commits = gitResult(root, ["log", "--reverse", "--format=%H", "--", relative]).stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    const content = gitResult(root, ["show", `${commit}:${relative}`], { allowFailure: true });
    if (content.status !== 0) continue;
    let historical;
    try { historical = JSON.parse(content.stdout); } catch { continue; }
    if (historical.id !== item.id || historical.status !== "DONE") continue;
    const manifestResult = gitResult(root, ["show", `${commit}:.ai-harness/manifest.json`], { allowFailure: true });
    invariant(manifestResult.status === 0 && !JSON.parse(manifestResult.stdout).integrityVersion, "LEGACY_ARCHIVE_INVALID", "新协议工作项不能伪装成旧记录。" );
    const { updatedAt: ignoredCurrent, ...currentBody } = item;
    const { updatedAt: ignoredHistorical, ...historicalBody } = historical;
    invariant(JSON.stringify(currentBody) === JSON.stringify(historicalBody), "LEGACY_ARCHIVE_CHANGED", `历史终态记录 ${item.id} 已改变，不能当作原提交归档。`);
    return { source: await commitSnapshot(root, commit), at: item.history.at(-1).at, legacy: true, anchor: commit };
  }
  invariant(false, "LEGACY_ARCHIVE_REQUIRED", `旧终态工作项 ${item.id} 缺少已提交的归档依据。`);
}

export async function collectScopeErrors(root, records, items) {
  const config = await readJson(path.join(root, ".ai-harness/config.json"));
  const current = await sourceSnapshot(root);
  const errors = [];
  const warnings = [];
  const active = records.filter(({ item }) => item.status !== "DONE");
  const activeScopes = [...new Set(active.flatMap(({ item, plan }) => plannedScopes(item, plan)))];
  const archives = [];
  for (const { item, plan } of records.filter(({ item }) => item.status === "DONE")) {
    try {
      if (!item.delivery) {
        invariant(!item.integrityVersion, "DELIVERY_REQUIRED", `工作项 ${item.id} 缺少交付快照。`);
        archives.push({ item, scopes: [], ...await legacyArchive(root, item, config) });
        continue;
      }
      invariant(item.delivery.planDigest === planDigest(item, plan), "DELIVERY_PLAN_CHANGED", `工作项 ${item.id} 的交付计划已改变。`);
      const source = await loadSnapshot(root, item.delivery.source);
      const baseline = await loadSnapshot(root, item.delivery.baseline);
      const scopes = plannedScopes(item, plan);
      const changes = ownedChanges(baseline, source, scopes);
      invariant(JSON.stringify(item.delivery.ownedChanges) === JSON.stringify(changes), "DELIVERY_OWNERSHIP_INVALID", `${item.id}: 交付归属与批准范围及快照不一致。`);
      archives.push({ item, source, baseline, changes, baselineAt: item.delivery.baselineAt, at: item.delivery.at, legacy: false });
    } catch (error) { errors.push(error.message); }
  }
  const controls = items.map((item) => `${config.workItemsDirectory}/${item.id}/**`);
  const ordered = archives.toSorted((left, right) => left.at.localeCompare(right.at));
  const first = active.toSorted((left, right) => left.item.baseline.completedAt.localeCompare(right.item.baseline.completedAt))[0];
  const latest = ordered.at(-1);
  let frontier = first ? await baselineSnapshot(root, first.item, current, config)
    : latest ? (latest.legacy ? latest.source : latest.baseline)
      : await commitSnapshot(root, gitResult(root, ["rev-parse", "HEAD"]).stdout.trim());
  const baselineAt = first?.item.baseline.completedAt ?? (latest?.legacy ? latest.at : latest?.baselineAt) ?? new Date().toISOString();
  const files = Object.assign(Object.create(null), frontier.files);
  for (const archive of ordered.filter((entry) => !entry.legacy && entry.at >= baselineAt)) {
    for (const change of archive.changes) {
      if (change.after === null) delete files[change.path];
      else files[change.path] = change.after;
    }
  }
  frontier = makeSnapshot(files);
  const changed = new Set(snapshotChanges(frontier, current));
  for (const file of changed) {
    if (!activeScopes.some((scope) => fileMatchesScope(file, scope))) errors.push(`当前变更没有活动工作项授权，历史完成范围不能复用：${file}`);
  }
  return { errors: [...new Set(errors)], warnings, changedFiles: [...changed].sort(), scopes: [...new Set([...activeScopes, ...controls])].sort(), frontier, baselineAt };
}

export async function prepareDelivery(root, item, plan, current) {
  const config = await readJson(path.join(root, ".ai-harness/config.json"));
  const directory = path.join(root, config.workItemsDirectory);
  const items = [];
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const other = entry.name === item.id ? item : await readJson(path.join(directory, entry.name, "state.json"));
    items.push(other);
    if (!["IMPLEMENTING", "VERIFYING", "CODE_REVIEW", "READY_FOR_ACCEPTANCE", "DONE"].includes(other.status)) continue;
    records.push({ item: other, plan: other.id === item.id ? plan : await readJson(path.join(directory, entry.name, "plan.json")) });
  }
  const scope = await collectScopeErrors(root, records, items);
  invariant(scope.errors.length === 0, "CHECK_FAILED", "交付前范围检查失败，未写入终态。", { errors: scope.errors });
  return { baseline: scope.frontier, baselineAt: scope.baselineAt, ownedChanges: ownedChanges(scope.frontier, current, plannedScopes(item, plan)) };
}
