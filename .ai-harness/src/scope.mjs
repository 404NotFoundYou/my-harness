import path from "node:path";
import { createHash } from "node:crypto";
import { distributionPaths, INSTRUCTION_FILES, validateInstallReceipt } from "./installer.mjs";
import { mergeManagedFile } from "./managed-block.mjs";
import { readdir } from "node:fs/promises";
import { readJson, resolveProjectPath } from "./filesystem.mjs";
import { commitSnapshot, controlPath, snapshotReader, makeSnapshot, snapshotChanges, sourceSnapshot } from "./snapshot.mjs";
import { fileFingerprint, gitResult } from "./git.mjs";
import { fileMatchesScope, taskWriteScopes } from "./validator.mjs";
import { planDigest, readEvidence } from "./verification.mjs";
import { invariant } from "./errors.mjs";

export function plannedScopes(item, plan) {
  return [...new Set((plan?.tasks || []).flatMap(taskWriteScopes))];
}

function ownedChanges(baseline, source, scopes) {
  return snapshotChanges(baseline, source).filter((file) => scopes.some((scope) => fileMatchesScope(file, scope)))
    .map((file) => ({ path: file, before: baseline.files[file] ?? null, after: source.files[file] ?? null }));
}

async function baselineSnapshot(root, item, current, config, readSnapshot) {
  if (item.baseline.repository?.source) return readSnapshot(item.baseline.repository.source);
  const baseline = await commitSnapshot(root, item.baseline.repository.commit, config);
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
    return { source: await commitSnapshot(root, commit, config), at: item.history.at(-1).at, legacy: true, anchor: commit };
  }
  invariant(false, "LEGACY_ARCHIVE_REQUIRED", `旧终态工作项 ${item.id} 缺少已提交的归档依据。`);
}

function declaredTrivialDoc(root, base, ancestor, current) {
  const changed = snapshotChanges(ancestor, current);
  if (changed.length !== 1) return null;
  const [file] = changed;
  if (!(file === "README.md" || /^docs\/.+\.md$/.test(file)) || /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/i.test(file)) return null;
  if (!ancestor.files[file]?.startsWith("100644:") || !current.files[file]?.startsWith("100644:")) return null;
  const commit = gitResult(root, ["--literal-pathspecs", "log", "-1", "--no-merges", "--format=%H", `${base}..HEAD`, "--", file]).stdout.trim();
  if (!commit) return null;
  const declaration = gitResult(root, ["show", "-s", "--format=%(trailers:key=Harness-Trivial-Doc,valueonly)", commit]).stdout.trim();
  if (declaration !== file) return null;
  const blob = gitResult(root, ["rev-parse", `${commit}:${file}`]).stdout.trim();
  return current.files[file] === `100644:${blob}` ? file : null;
}

function installBlobs(root, entries) {
  const ids = [...new Set(entries.filter(Boolean).map(entry => entry.split(":")[1]))];
  const bytes = gitResult(root, ["cat-file", "--batch"], { input: ids.join("\n") + "\n", encoding: null }).stdout;
  const blobs = new Map();
  let offset = 0;
  for (const id of ids) {
    const end = bytes.indexOf(10, offset);
    const [oid, type, size] = bytes.toString("ascii", offset, end).split(" ");
    invariant(end >= offset && oid === id && type === "blob" && /^\d+$/.test(size), "INVALID_INITIAL_INSTALL", "首次接入缺少 Git 文件内容。");
    offset = end + 1 + Number(size);
    invariant(bytes[offset] === 10, "INVALID_INITIAL_INSTALL", "首次接入的 Git 文件内容不完整。");
    blobs.set(id, bytes.subarray(end + 1, offset));
    offset += 1;
  }
  return entry => blobs.get(entry.split(":")[1]);
}

// Replay only the first install from committed bytes; a later work item may then build on it.
async function applyInitialInstall(root, base, files, config) {
  const projectPath = ".ai-harness/project.json", receiptPath = ".ai-harness/install-receipt.json", manifestPath = ".ai-harness/manifest.json";
  if (files[projectPath] || files[receiptPath] || files[manifestPath]) return;
  const introduction = gitResult(root, ["log", "--reverse", "--diff-filter=A", "--format=%H", `${base}..HEAD`, "--", projectPath]).stdout.split(/\r?\n/)[0];
  if (!introduction || gitResult(root, ["log", "--full-history", "-1", "--format=%H", base, "--", projectPath]).stdout.trim()) return;
  const installed = (await commitSnapshot(root, introduction, config)).files;
  if (![receiptPath, projectPath, manifestPath].every(file => installed[file]?.startsWith("100644:"))) return;
  const metadata = installBlobs(root, [installed[receiptPath], installed[projectPath], installed[manifestPath]]);
  const { initialInstall, ...project } = JSON.parse(metadata(installed[projectPath]));
  const parent = gitResult(root, ["rev-parse", `${introduction}^`]).stdout.trim();
  if (!initialInstall || project.mode !== "existing" || project.repository?.commit !== parent) return;
  const prior = (await commitSnapshot(root, parent, config)).files;
  if ([projectPath, receiptPath, manifestPath].some(file => prior[file])) return;
  const receipt = validateInstallReceipt(JSON.parse(metadata(installed[receiptPath])));
  const manifest = JSON.parse(metadata(installed[manifestPath]));
  const paths = distributionPaths(manifest);
  invariant(receipt.source && receipt.contentHash === initialInstall.receipt && receipt.harnessVersion === manifest.version && project.harnessVersion === manifest.version &&
    JSON.stringify(receipt.files.map(entry => entry.relative).sort()) === JSON.stringify(paths), "INVALID_INITIAL_INSTALL", "首次接入的收据、版本或发行清单不一致。");
  const blob = installBlobs(root, [...paths.map(file => installed[file]),
    ...INSTRUCTION_FILES.flatMap(({ relative }) => [installed[relative], prior[relative]]).filter(entry => entry?.startsWith("100644:"))]);
  for (const { relative, sha256 } of receipt.files) {
    const entry = installed[relative];
    invariant(entry?.startsWith("100644:") && createHash("sha256").update(blob(entry)).digest("hex") === sha256,
      "INVALID_INITIAL_INSTALL", `首次接入文件与收据不符：${relative}`);
    if (!prior[relative] && !files[relative]) files[relative] = entry;
  }
  for (const { relative, compatibleImport } of INSTRUCTION_FILES) {
    if (prior[relative] !== files[relative] || !installed[relative]?.startsWith("100644:") || (prior[relative] && !prior[relative].startsWith("100644:"))) continue;
    const existing = prior[relative] ? blob(prior[relative]).toString("utf8") : "";
    const body = blob(installed[`.ai-harness/templates/instructions/${relative}`]).toString("utf8");
    const merged = mergeManagedFile({ existing, relative, version: manifest.version, body, compatibleImport });
    if (blob(installed[relative]).equals(Buffer.from(merged.content))) files[relative] = installed[relative];
  }
  files[receiptPath] = installed[receiptPath];
  if (createHash("sha256").update(JSON.stringify(project)).digest("hex") === initialInstall.metadata) files[projectPath] = installed[projectPath];
}

async function deliveryArchive(item, plan, readSnapshot) {
  invariant(item.delivery.planDigest === planDigest(item, plan), "DELIVERY_PLAN_CHANGED", `工作项 ${item.id} 的交付计划已改变。`);
  const source = await readSnapshot(item.delivery.source);
  const baseline = await readSnapshot(item.delivery.baseline);
  const changes = ownedChanges(baseline, source, plannedScopes(item, plan));
  invariant(JSON.stringify(item.delivery.ownedChanges) === JSON.stringify(changes), "DELIVERY_OWNERSHIP_INVALID", `${item.id}: 交付归属与批准范围及快照不一致。`);
  return { item, source, baseline, changes, baselineAt: item.delivery.baselineAt, at: item.delivery.at };
}

async function priorDeliveries(root, item, config, readSnapshot) {
  const archives = [];
  let evidence;
  // Only a transition out of DONE freezes a delivery. Other rework snapshots are drafts.
  for (const [index, step] of item.history.entries()) {
    if (step.from !== "DONE" || !["reopen", "replan"].includes(step.action)) continue;
    const revision = step.revision - 1;
    const prefix = `${config.workItemsDirectory}/${item.id}/revisions/${revision}`;
    const read = async suffix => readJson(await resolveProjectPath(root, `${prefix}-${suffix}.json`, { mustExist: true }));
    const [saved, plan] = await Promise.all([read("state"), read("plan")]);
    invariant(saved.id === item.id && saved.status === "DONE" && (saved.revision || 1) === revision &&
      plan.workItemId === item.id && (plan.revision || 1) === revision && saved.plan?.approved &&
      JSON.stringify(saved.history) === JSON.stringify(item.history.slice(0, index)),
    "INVALID_ARCHIVED_REVISION", `${item.id}: 历史修订 ${revision} 与工作项或计划不一致。`);
    evidence ??= await readEvidence(root, item.id);
    const accepted = evidence.findLast(event => event.kind === "acceptance" && !event.taskId && (event.revision || 1) === revision);
    invariant(accepted?.status === "pass" && saved.acceptance?.evidence?.includes(accepted.id) &&
      accepted.source?.digest === saved.delivery?.source?.digest && accepted.planDigest === saved.delivery?.planDigest,
    "INVALID_ARCHIVED_REVISION", `${item.id}: 历史修订 ${revision} 缺少对应的验收证据。`);
    archives.push(await deliveryArchive(saved, plan, readSnapshot));
  }
  return archives;
}

async function compareCommitRange(root, config, base, current, ordered) {
  invariant(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base) &&
    gitResult(root, ["rev-parse", "--verify", `${base}^{commit}`], { allowFailure: true }).stdout.trim() === base &&
    gitResult(root, ["merge-base", "--is-ancestor", base, "HEAD"], { allowFailure: true }).status === 0,
  "INVALID_CI_BASE", "CI 基准必须是当前 HEAD 的可用祖先提交，使用完整提交标识。");
  invariant(gitResult(root, ["rev-parse", "--is-shallow-repository"]).stdout.trim() === "false",
    "CI_HISTORY_REQUIRED", "CI 基准检查需要完整 Git 历史以核对过去的工作项归属。");
  const ancestor = await commitSnapshot(root, base, config);
  const directory = config.workItemsDirectory;
  const existing = new Set(gitResult(root, ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", base, "--", directory]).stdout.split("\0"));
  const touched = new Set(gitResult(root, ["--literal-pathspecs", "diff", "--name-only", "--no-renames", "-z", base, "--", directory]).stdout.split("\0"));
  const files = Object.assign(Object.create(null), ancestor.files);
  await applyInitialInstall(root, base, files, config);
  for (const archive of ordered) {
    if (archive.legacy) continue;
    const state = `${directory}/${archive.item.id}/state.json`;
    if (existing.has(state)) {
      if (!touched.has(state)) continue;
      const previous = JSON.parse(gitResult(root, ["show", `${base}:${state}`]).stdout);
      const revision = archive.item.revision || 1, baseRevision = previous.revision || 1;
      if (revision < baseRevision || (revision === baseRevision && previous.status === "DONE")) continue;
    } else if (gitResult(root, ["--literal-pathspecs", "log", "--full-history", "-1", "--format=%H", base, "--", state]).stdout.trim()) {
      continue;
    }
    for (const change of archive.changes) {
      if ((files[change.path] ?? null) !== change.before) continue;
      if (change.after === null) delete files[change.path];
      else files[change.path] = change.after;
    }
  }
  const unexplained = snapshotChanges(makeSnapshot(files), current);
  const trivialDoc = unexplained.length ? declaredTrivialDoc(root, base, ancestor, current) : null;
  return { changedFiles: unexplained.filter(file => file !== trivialDoc), trivialDoc };
}

export async function collectScopeErrors(root, records, items, { base = null, config, readSnapshot = snapshotReader(root) } = {}) {
  config ??= await readJson(path.join(root, ".ai-harness/config.json"));
  const current = await sourceSnapshot(root, config);
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
      if (base !== null) archives.push(...await priorDeliveries(root, item, config, readSnapshot));
      archives.push(await deliveryArchive(item, plan, readSnapshot));
    } catch (error) { errors.push(error.message); }
  }
  const controls = items.map((item) => `${config.workItemsDirectory}/${item.id}/**`);
  const ordered = archives.toSorted((left, right) => left.at.localeCompare(right.at));
  if (base !== null) {
    const { changedFiles, trivialDoc } = await compareCommitRange(root, config, base, current, ordered);
    for (const file of changedFiles) errors.push(`CI 基准后的变更缺少对应的本次交付：${file}`);
    return { errors, warnings, changedFiles, scopes: controls.sort(), trivialDoc };
  }
  const first = active.toSorted((left, right) => left.item.baseline.completedAt.localeCompare(right.item.baseline.completedAt))[0];
  const latest = ordered.at(-1);
  let frontier = first ? await baselineSnapshot(root, first.item, current, config, readSnapshot)
    : latest ? (latest.legacy ? latest.source : latest.baseline)
      : await commitSnapshot(root, gitResult(root, ["rev-parse", "HEAD"]).stdout.trim(), config);
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
  const scope = await collectScopeErrors(root, records, items, { config });
  invariant(scope.errors.length === 0, "CHECK_FAILED", "交付前范围检查失败，未写入终态。", { errors: scope.errors });
  return { baseline: scope.frontier, baselineAt: scope.baselineAt, ownedChanges: ownedChanges(scope.frontier, current, plannedScopes(item, plan)) };
}
