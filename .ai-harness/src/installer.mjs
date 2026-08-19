import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, copyFileAtomic, exists, readJson, writeFileAtomic } from "./filesystem.mjs";
import { getGitBaseline } from "./git.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import { inspectManagedBlock, mergeManagedFile, removeManagedBlock } from "./managed-block.mjs";

const INSTRUCTION_FILES = Object.freeze([
  { relative: "AGENTS.md", compatibleImport: null },
  { relative: "CLAUDE.md", compatibleImport: "@AGENTS.md" },
  { relative: "GEMINI.md", compatibleImport: "@./AGENTS.md" },
]);
const INSTALL_RECEIPT_RELATIVE = ".ai-harness/install-receipt.json";
const STANDARD_WORKFLOW_RELATIVE = ".github/workflows/ai-harness.yml";

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function receiptPayloadPathAllowed(relative) {
  if (relative === STANDARD_WORKFLOW_RELATIVE) return true;
  return relative.startsWith(".ai-harness/")
    && !relative.includes("\\")
    && !relative.includes("\0")
    && relative !== INSTALL_RECEIPT_RELATIVE
    && relative !== ".ai-harness/project.json"
    && !relative.startsWith(".ai-harness/work-items/")
    && !relative.startsWith(".ai-harness/backups/")
    && path.posix.normalize(relative) === relative;
}

function canonicalReceiptBody(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    harnessVersion: receipt.harnessVersion,
    files: receipt.files.map(({ relative, sha256 }) => ({ relative, sha256 })),
    instructions: receipt.instructions.map((entry) => ({
      relative: entry.relative,
      created: entry.created,
      prefix: entry.prefix,
      suffix: entry.suffix,
      replacementBase64: entry.replacementBase64,
    })),
  };
}

function validateInstallReceipt(receipt, code) {
  invariant(receipt && typeof receipt === "object" && !Array.isArray(receipt), code, "Harness 安装收据结构无效。" );
  invariant(receipt.schemaVersion === 1 && typeof receipt.harnessVersion === "string", code, "Harness 安装收据版本无效。" );
  invariant(Array.isArray(receipt.files) && Array.isArray(receipt.instructions), code, "Harness 安装收据清单无效。" );

  const filePaths = new Set();
  for (const entry of receipt.files) {
    invariant(
      entry && typeof entry.relative === "string" && receiptPayloadPathAllowed(entry.relative),
      code,
      "Harness 安装收据包含不允许的 payload 路径。",
    );
    invariant(/^[a-f0-9]{64}$/.test(entry.sha256 || ""), code, "Harness 安装收据包含无效文件哈希。" );
    invariant(!filePaths.has(entry.relative), code, "Harness 安装收据包含重复文件。" );
    filePaths.add(entry.relative);
  }
  invariant(filePaths.has(".ai-harness/manifest.json"), code, "Harness 安装收据缺少 Runtime manifest。" );

  const instructionPaths = new Set();
  const allowedInstructions = new Set(INSTRUCTION_FILES.map(({ relative }) => relative));
  for (const entry of receipt.instructions) {
    invariant(entry && allowedInstructions.has(entry.relative), code, "Harness 安装收据包含无效规则文件。" );
    invariant(!instructionPaths.has(entry.relative), code, "Harness 安装收据包含重复规则文件。" );
    invariant(typeof entry.created === "boolean", code, "Harness 安装收据规则归属无效。" );
    invariant(
      typeof entry.prefix === "string"
      && typeof entry.suffix === "string"
      && entry.prefix.length <= 4
      && entry.suffix.length <= 2
      && /^[\r\n]*$/.test(entry.prefix)
      && /^[\r\n]*$/.test(entry.suffix),
      code,
      "Harness 安装收据规则边界无效。",
    );
    invariant(
      entry.replacementBase64 === null
      || (
        typeof entry.replacementBase64 === "string"
        && Buffer.from(entry.replacementBase64, "base64").toString("base64") === entry.replacementBase64
      ),
      code,
      "Harness 安装收据规则恢复内容无效。",
    );
    instructionPaths.add(entry.relative);
  }

  const canonical = canonicalReceiptBody(receipt);
  invariant(
    receipt.contentHash === hash(Buffer.from(JSON.stringify(canonical))),
    code,
    "Harness 安装收据哈希无效。",
  );
  return receipt;
}

async function loadInstallReceipt(targetRoot, { required = false, code = "INSTALL_RECEIPT_INVALID" } = {}) {
  const targetPath = path.join(targetRoot, INSTALL_RECEIPT_RELATIVE);
  await assertWritableParents(targetRoot, INSTALL_RECEIPT_RELATIVE);
  if (!(await exists(targetPath))) {
    invariant(!required, "UNINSTALL_RECEIPT_REQUIRED", "目标缺少 Harness 安装收据；请先从可信源重新安装后再卸载。" );
    return null;
  }
  const info = await lstat(targetPath);
  invariant(info.isFile() && !info.isSymbolicLink(), "TARGET_TYPE_CONFLICT", "Harness 安装收据不是普通文件。" );
  const content = await readFile(targetPath);
  let receipt;
  try {
    receipt = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new HarnessError(code, "Harness 安装收据无法解析。", { cause: error.message });
  }
  validateInstallReceipt(receipt, code);
  return { receipt, content, targetPath };
}

async function listFiles(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new HarnessError("SOURCE_SYMLINK", `安装源包含符号链接：${relative}`);
    if (entry.isDirectory()) output.push(...(await listFiles(absolute, relative)));
    else if (entry.isFile()) output.push(relative);
  }
  return output;
}

async function assertWritableParents(targetRoot, relative) {
  const segments = relative.split("/").slice(0, -1);
  let cursor = targetRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    if (!(await exists(cursor))) break;
    const info = await lstat(cursor);
    invariant(!info.isSymbolicLink(), "TARGET_SYMLINK", `安装目标父路径是符号链接：${relative}`);
  }
}

async function assertSourceFile(sourceRoot, relative) {
  let cursor = sourceRoot;
  let info;
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment);
    info = await lstat(cursor);
    invariant(!info.isSymbolicLink(), "SOURCE_SYMLINK", `安装源包含符号链接：${relative}`);
  }
  invariant(info?.isFile(), "SOURCE_TYPE_CONFLICT", `安装源不是普通文件：${relative}`);
}

export async function installationFiles(sourceRoot) {
  const files = [];
  const runtimeRoot = path.join(sourceRoot, ".ai-harness");
  const runtimeInfo = await lstat(runtimeRoot);
  invariant(
    runtimeInfo.isDirectory() && !runtimeInfo.isSymbolicLink(),
    "SOURCE_SYMLINK",
    "安装源 .ai-harness 必须是普通目录，不能是符号链接或联接。",
  );
  for (const relative of await listFiles(runtimeRoot)) {
    if (
      relative === "project.json"
      || relative === "install-receipt.json"
      || relative.startsWith("work-items/")
      || relative.startsWith("backups/")
    ) continue;
    files.push(`.ai-harness/${relative}`);
  }
  if (await exists(path.join(sourceRoot, STANDARD_WORKFLOW_RELATIVE))) {
    await assertSourceFile(sourceRoot, STANDARD_WORKFLOW_RELATIVE);
    files.push(STANDARD_WORKFLOW_RELATIVE);
  }
  return files.sort();
}

async function planInstructionOperations(source, targetRoot, version, force) {
  const operations = [];
  for (const definition of INSTRUCTION_FILES) {
    const relative = definition.relative;
    const sourcePath = path.join(source, ".ai-harness", "templates", "instructions", relative);
    const targetPath = path.join(targetRoot, relative);
    await assertWritableParents(targetRoot, relative);
    const body = await readFile(sourcePath, "utf8");
    if (!(await exists(targetPath))) {
      const merged = mergeManagedFile({ existing: "", relative, version, body, compatibleImport: definition.compatibleImport });
      operations.push({
        relative,
        targetPath,
        ...merged,
        content: Buffer.from(merged.content),
        existing: false,
        existingContent: "",
      });
      continue;
    }
    const targetInfo = await lstat(targetPath);
    invariant(targetInfo.isFile() && !targetInfo.isSymbolicLink(), "TARGET_TYPE_CONFLICT", `目标不是普通文件：${relative}`);
    const existing = await readFile(targetPath, "utf8");
    const merged = mergeManagedFile({
      existing,
      relative,
      version,
      body,
      force,
      compatibleImport: definition.compatibleImport,
    });
    operations.push({
      relative,
      targetPath,
      ...merged,
      content: Buffer.from(merged.content),
      existing: true,
      existingContent: existing,
      snapshotHash: hash(Buffer.from(existing)),
    });
  }
  return operations;
}

function instructionReceipt(operation, previousReceipt) {
  if (!operation.managed) return null;
  const previous = previousReceipt?.instructions.find((entry) => entry.relative === operation.relative);
  const existingInspection = inspectManagedBlock(operation.existingContent, operation.relative);
  if (previous && existingInspection.present) return previous;

  const installed = operation.content.toString("utf8");
  const inspection = inspectManagedBlock(installed, operation.relative);
  if (!inspection.present) return null;

  if (operation.action === "adopt-managed") {
    return {
      relative: operation.relative,
      created: false,
      prefix: "",
      suffix: installed.slice(inspection.end),
      replacementBase64: Buffer.from(operation.existingContent, "utf8").toString("base64"),
    };
  }
  if (["create", "merge"].includes(operation.action)) {
    invariant(
      installed.startsWith(operation.existingContent),
      "INSTALL_RECEIPT_INVALID",
      `无法记录 ${operation.relative} 的托管边界。`,
    );
    return {
      relative: operation.relative,
      created: !operation.existing,
      prefix: installed.slice(operation.existingContent.length, inspection.start),
      suffix: installed.slice(inspection.end),
      replacementBase64: null,
    };
  }
  return {
    relative: operation.relative,
    created: false,
    prefix: "",
    suffix: "",
    replacementBase64: null,
  };
}

function buildInstallReceipt(version, payloadOperations, instructionOperations, previousReceipt) {
  const body = {
    schemaVersion: 1,
    harnessVersion: version,
    files: payloadOperations
      .map((operation) => ({ relative: operation.relative, sha256: hash(operation.sourceContent) }))
      .sort((left, right) => left.relative.localeCompare(right.relative)),
    instructions: instructionOperations
      .map((operation) => instructionReceipt(operation, previousReceipt))
      .filter(Boolean)
      .sort((left, right) => left.relative.localeCompare(right.relative)),
  };
  return {
    ...body,
    contentHash: hash(Buffer.from(JSON.stringify(body))),
  };
}

async function planInstallReceiptOperation(targetRoot, receipt) {
  const targetPath = path.join(targetRoot, INSTALL_RECEIPT_RELATIVE);
  const content = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await assertWritableParents(targetRoot, INSTALL_RECEIPT_RELATIVE);
  if (!(await exists(targetPath))) {
    return {
      relative: INSTALL_RECEIPT_RELATIVE,
      targetPath,
      action: "create-receipt",
      content,
      existing: false,
    };
  }
  const current = await loadInstallReceipt(targetRoot);
  return {
    relative: INSTALL_RECEIPT_RELATIVE,
    targetPath,
    action: hash(current.content) === hash(content) ? "skip" : "update-receipt",
    content,
    existing: true,
    snapshotHash: hash(current.content),
  };
}

function operationSummary(operation) {
  return {
    relative: operation.relative,
    action: operation.action,
    ...(operation.managed !== undefined ? { managed: operation.managed } : {}),
    ...(operation.compatibleExisting ? { compatibleExisting: true } : {}),
    ...(operation.action === "merge" ? { preservedExisting: true, conflictReviewRequired: true } : {}),
  };
}

function uninstallOperationSummary(operation) {
  return {
    relative: operation.relative,
    action: operation.action,
    ...(operation.reason ? { reason: operation.reason } : {}),
    ...(operation.managed !== undefined ? { managed: operation.managed } : {}),
    ...(operation.action === "remove-managed" ? { preservedExisting: true } : {}),
  };
}

async function planUninstallInstructionOperations(targetRoot, receipt) {
  const operations = [];
  for (const definition of INSTRUCTION_FILES) {
    const relative = definition.relative;
    const targetPath = path.join(targetRoot, relative);
    await assertWritableParents(targetRoot, relative);
    if (!(await exists(targetPath))) {
      operations.push({ relative, targetPath, action: "skip", reason: "not-found", existing: false });
      continue;
    }
    const targetInfo = await lstat(targetPath);
    invariant(targetInfo.isFile() && !targetInfo.isSymbolicLink(), "TARGET_TYPE_CONFLICT", `目标不是普通文件：${relative}`);
    const current = await readFile(targetPath, "utf8");
    const inspection = inspectManagedBlock(current, relative);
    const ownership = receipt.instructions.find((entry) => entry.relative === relative);
    invariant(
      !inspection.present || ownership,
      "UNINSTALL_RECEIPT_INVALID",
      `${relative} 存在托管块，但安装收据缺少其归属记录。`,
    );
    const removal = removeManagedBlock(current, relative, ownership || undefined);
    operations.push({
      relative,
      targetPath,
      ...removal,
      content: Buffer.from(removal.content),
      existing: true,
      snapshotHash: hash(Buffer.from(current)),
      ...(removal.action === "skip" ? { reason: "not-managed" } : {}),
    });
  }
  return operations;
}

function uninstallMutates(operation) {
  return ["remove-managed", "delete-managed-only", "remove-runtime", "remove-project", "remove-receipt"].includes(operation.action);
}

async function assertUninstallOperationUnchanged(targetRoot, operation) {
  invariant(inside(targetRoot, operation.targetPath), "TARGET_ESCAPE", `卸载目标路径越界：${operation.relative}`);
  await assertWritableParents(targetRoot, operation.relative);
  invariant(await exists(operation.targetPath), "UNINSTALL_TARGET_CHANGED", `卸载目标在执行前已变化：${operation.relative}`);
  const info = await lstat(operation.targetPath);
  invariant(
    info.isFile() && !info.isSymbolicLink(),
    "UNINSTALL_TARGET_CHANGED",
    `卸载目标类型在执行前已变化：${operation.relative}`,
  );
  const current = await readFile(operation.targetPath);
  invariant(
    hash(current) === operation.snapshotHash,
    "UNINSTALL_TARGET_CHANGED",
    `卸载目标内容在执行前已变化：${operation.relative}`,
  );
}

async function assertUninstallOperationsUnchanged(targetRoot, operations) {
  for (const operation of operations) await assertUninstallOperationUnchanged(targetRoot, operation);
}

async function assertAppliedOperationUnchanged(targetRoot, operation) {
  await assertWritableParents(targetRoot, operation.relative);
  if (operation.action !== "remove-managed") {
    invariant(
      !(await exists(operation.targetPath)),
      "UNINSTALL_TARGET_CHANGED",
      `已删除目标在回滚前被重新创建：${operation.relative}`,
    );
    return;
  }
  invariant(await exists(operation.targetPath), "UNINSTALL_TARGET_CHANGED", `回滚目标已丢失：${operation.relative}`);
  const info = await lstat(operation.targetPath);
  invariant(
    info.isFile() && !info.isSymbolicLink(),
    "UNINSTALL_TARGET_CHANGED",
    `回滚目标类型已变化：${operation.relative}`,
  );
  invariant(
    hash(await readFile(operation.targetPath)) === hash(operation.content),
    "UNINSTALL_TARGET_CHANGED",
    `回滚目标内容已变化：${operation.relative}`,
  );
}

async function callUninstallHook(hooks, name, payload) {
  if (typeof hooks?.[name] === "function") await hooks[name](payload);
}

async function discardUninstallBackup(backupRoot, backupsDirectoryExisted) {
  await rm(backupRoot, { recursive: true, force: true });
  if (!backupsDirectoryExisted) {
    try {
      await rmdir(path.dirname(backupRoot));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }
}

async function removeEmptyOperationDirectories(targetRoot, operations) {
  const directories = new Set();
  for (const operation of operations) {
    let current = path.dirname(operation.targetPath);
    while (current !== targetRoot && inside(targetRoot, current)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try {
      await rmdir(directory);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
    }
  }
}

export async function installRuntime(sourceRoot, target, { dryRun = false, force = false } = {}) {
  const source = await realpath(sourceRoot);
  const targetRoot = await realpath(target);
  invariant((await stat(targetRoot)).isDirectory(), "TARGET_NOT_DIRECTORY", "安装目标必须是目录。" );
  const manifest = await readJson(path.join(source, ".ai-harness", "manifest.json"));
  const files = await installationFiles(source);
  const previousReceiptInfo = await loadInstallReceipt(targetRoot);
  const operations = await planInstructionOperations(source, targetRoot, manifest.version, force);
  const instructionOperations = [...operations];
  const payloadOperations = [];

  for (const relative of files) {
    const sourcePath = path.resolve(source, relative);
    const targetPath = path.resolve(targetRoot, relative);
    invariant(inside(source, sourcePath), "SOURCE_ESCAPE", `安装源路径越界：${relative}`);
    invariant(inside(targetRoot, targetPath), "TARGET_ESCAPE", `安装目标路径越界：${relative}`);
    await assertWritableParents(targetRoot, relative);
    const sourceContent = await readFile(sourcePath);
    if (!(await exists(targetPath))) {
      const operation = { relative, action: "create", sourcePath, targetPath, sourceContent, existing: false };
      operations.push(operation);
      payloadOperations.push(operation);
      continue;
    }
    const targetInfo = await lstat(targetPath);
    invariant(targetInfo.isFile() && !targetInfo.isSymbolicLink(), "TARGET_TYPE_CONFLICT", `目标不是普通文件：${relative}`);
    const targetContent = await readFile(targetPath);
    if (hash(sourceContent) === hash(targetContent)) {
      const operation = {
        relative,
        action: "skip",
        sourcePath,
        sourceContent,
        targetPath,
        existing: true,
        snapshotHash: hash(targetContent),
      };
      operations.push(operation);
      payloadOperations.push(operation);
    } else {
      const operation = {
        relative,
        action: force ? "replace" : "conflict",
        sourcePath,
        targetPath,
        sourceContent,
        targetContent,
        existing: true,
        snapshotHash: hash(targetContent),
      };
      operations.push(operation);
      payloadOperations.push(operation);
    }
  }

  const receipt = buildInstallReceipt(
    manifest.version,
    payloadOperations,
    instructionOperations,
    previousReceiptInfo?.receipt,
  );
  operations.push(await planInstallReceiptOperation(targetRoot, receipt));

  const agentsOperation = operations.find((operation) => operation.relative === "AGENTS.md");
  const config = await readJson(path.join(source, ".ai-harness", "config.json"));
  if (agentsOperation?.content.length > config.rootInstructionsMaxBytes) {
    throw new HarnessError("ROOT_INSTRUCTIONS_TOO_LARGE", "合并后的 AGENTS.md 超过 Runtime 大小上限；未写入任何文件。", {
      bytes: agentsOperation.content.length,
      maximum: config.rootInstructionsMaxBytes,
    });
  }

  const conflicts = operations.filter((operation) => operation.action === "conflict");
  if (dryRun) return { dryRun: true, operations: operations.map(operationSummary) };
  if (conflicts.length > 0) {
    throw new HarnessError("INSTALL_CONFLICT", "目标项目存在不同内容，默认拒绝覆盖。", {
      files: conflicts.map((operation) => operation.relative),
    });
  }

  const transactionId = randomUUID();
  const backupRoot = path.join(targetRoot, ".ai-harness", "backups", transactionId);
  const applied = [];
  try {
    for (const operation of operations) {
      if (operation.action === "skip") continue;
      if (operation.existing) {
        const backupPath = path.join(backupRoot, operation.relative);
        await copyFileAtomic(operation.targetPath, backupPath);
        await rm(operation.targetPath, { force: true });
      }
      applied.push(operation);
      if (operation.content) await writeFileAtomic(operation.targetPath, operation.content);
      else await writeFileAtomic(operation.targetPath, operation.sourceContent);
    }
  } catch (error) {
    for (const operation of [...applied].reverse()) {
      await rm(operation.targetPath, { force: true });
      const backupPath = path.join(backupRoot, operation.relative);
      if (await exists(backupPath)) await copyFileAtomic(backupPath, operation.targetPath);
    }
    await rm(backupRoot, { recursive: true, force: true });
    throw new HarnessError("INSTALL_ROLLED_BACK", "安装失败，已回滚本次已应用文件。", {
      cause: error.message,
    });
  }

  return {
    dryRun: false,
    backup: operations.some((operation) => operation.existing && operation.action !== "skip")
      ? path.relative(targetRoot, backupRoot).replaceAll("\\", "/")
      : null,
    operations: operations.map(operationSummary),
  };
}

export async function uninstallRuntime(sourceRoot, target, { dryRun = false, confirm = false, hooks = null } = {}) {
  invariant(dryRun || confirm, "UNINSTALL_CONFIRMATION_REQUIRED", "正式卸载必须显式提供 --confirm。" );
  const source = await realpath(sourceRoot);
  const targetRoot = await realpath(target);
  invariant((await stat(targetRoot)).isDirectory(), "TARGET_NOT_DIRECTORY", "卸载目标必须是目录。" );
  invariant(
    source !== targetRoot,
    "UNINSTALL_SOURCE_EQUALS_TARGET",
    "卸载必须从独立 Harness 源仓库执行，不能使用目标项目内的 Runtime 自卸载。",
  );

  const sourceManifest = await readJson(path.join(source, ".ai-harness", "manifest.json"));
  const targetManifestPath = path.join(targetRoot, ".ai-harness", "manifest.json");
  invariant(await exists(targetManifestPath), "UNINSTALL_NOT_INSTALLED", "目标项目未安装 Harness Runtime。" );
  const targetManifestInfo = await lstat(targetManifestPath);
  invariant(
    targetManifestInfo.isFile() && !targetManifestInfo.isSymbolicLink(),
    "TARGET_TYPE_CONFLICT",
    "目标 Runtime manifest 不是普通文件。",
  );
  const targetManifest = await readJson(targetManifestPath);
  const receiptInfo = await loadInstallReceipt(targetRoot, { required: true, code: "UNINSTALL_RECEIPT_INVALID" });
  const receipt = receiptInfo.receipt;
  invariant(
    targetManifest.version === sourceManifest.version && receipt.harnessVersion === targetManifest.version,
    "UNINSTALL_VERSION_MISMATCH",
    "卸载源与目标 Runtime 版本不一致；请使用与目标版本一致的独立 Harness 源仓库卸载。",
    {
      sourceVersion: sourceManifest.version,
      targetVersion: targetManifest.version,
      receiptVersion: receipt.harnessVersion,
    },
  );

  const operations = await planUninstallInstructionOperations(targetRoot, receipt);
  for (const receiptFile of receipt.files) {
    const relative = receiptFile.relative;
    const sourcePath = path.resolve(source, relative);
    const targetPath = path.resolve(targetRoot, relative);
    invariant(inside(source, sourcePath), "SOURCE_ESCAPE", `卸载源路径越界：${relative}`);
    invariant(inside(targetRoot, targetPath), "TARGET_ESCAPE", `卸载目标路径越界：${relative}`);
    let sourceContent;
    try {
      await assertSourceFile(source, relative);
      sourceContent = await readFile(sourcePath);
    } catch (error) {
      throw new HarnessError("UNINSTALL_SOURCE_MISMATCH", `卸载源缺少收据记录的文件：${relative}`, {
        cause: error.message,
      });
    }
    invariant(
      hash(sourceContent) === receiptFile.sha256,
      "UNINSTALL_SOURCE_MISMATCH",
      `卸载源文件与安装收据不一致：${relative}`,
    );
    await assertWritableParents(targetRoot, relative);
    if (!(await exists(targetPath))) {
      operations.push({ relative, targetPath, action: "skip", reason: "not-found", existing: false });
      continue;
    }
    const targetInfo = await lstat(targetPath);
    invariant(targetInfo.isFile() && !targetInfo.isSymbolicLink(), "TARGET_TYPE_CONFLICT", `目标不是普通文件：${relative}`);
    const targetContent = await readFile(targetPath);
    const contentMatches = receiptFile.sha256 === hash(targetContent);
    operations.push({
      relative,
      sourcePath,
      targetPath,
      action: contentMatches ? "remove-runtime" : "conflict",
      ...(contentMatches ? {} : { reason: "content-mismatch" }),
      existing: true,
      snapshotHash: hash(targetContent),
    });
  }

  const projectRelative = ".ai-harness/project.json";
  const projectPath = path.join(targetRoot, projectRelative);
  await assertWritableParents(targetRoot, projectRelative);
  if (await exists(projectPath)) {
    const projectInfo = await lstat(projectPath);
    invariant(projectInfo.isFile() && !projectInfo.isSymbolicLink(), "TARGET_TYPE_CONFLICT", "project.json 不是普通文件。" );
    const projectContent = await readFile(projectPath);
    operations.push({
      relative: projectRelative,
      targetPath: projectPath,
      action: "remove-project",
      existing: true,
      snapshotHash: hash(projectContent),
    });
  } else {
    operations.push({ relative: projectRelative, targetPath: projectPath, action: "skip", reason: "not-found", existing: false });
  }
  operations.push({
    relative: INSTALL_RECEIPT_RELATIVE,
    targetPath: receiptInfo.targetPath,
    action: "remove-receipt",
    existing: true,
    snapshotHash: hash(receiptInfo.content),
  });

  const result = {
    dryRun,
    confirmationRequired: true,
    preserved: [
      ".ai-harness/work-items/**",
      ".ai-harness/backups/**",
      "项目文档、业务文件和规则文件中的非托管内容",
    ],
    operations: operations.map(uninstallOperationSummary),
  };
  if (dryRun) return result;

  const conflicts = operations.filter((operation) => operation.action === "conflict");
  if (conflicts.length > 0) {
    throw new HarnessError("UNINSTALL_CONFLICT", "目标 Runtime 或 CI 文件内容与卸载源不一致；未删除任何文件。", {
      files: conflicts.map((operation) => operation.relative),
    });
  }

  const mutations = operations.filter(uninstallMutates);
  const transactionId = randomUUID();
  const backupRoot = path.join(targetRoot, ".ai-harness", "backups", transactionId);
  const backupsDirectoryExisted = await exists(path.dirname(backupRoot));
  await assertWritableParents(targetRoot, `.ai-harness/backups/${transactionId}/placeholder`);
  await assertUninstallOperationsUnchanged(targetRoot, mutations);
  try {
    for (const operation of mutations) {
      await assertUninstallOperationUnchanged(targetRoot, operation);
      await copyFileAtomic(operation.targetPath, path.join(backupRoot, operation.relative));
      const backupContent = await readFile(path.join(backupRoot, operation.relative));
      invariant(
        hash(backupContent) === operation.snapshotHash,
        "UNINSTALL_TARGET_CHANGED",
        `卸载目标在备份期间已变化：${operation.relative}`,
      );
    }
  } catch (error) {
    await discardUninstallBackup(backupRoot, backupsDirectoryExisted);
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("UNINSTALL_BACKUP_FAILED", "卸载备份失败；未删除任何目标文件。", {
      cause: error.message,
    });
  }
  try {
    await callUninstallHook(hooks, "afterBackup", { backupRoot });
    await assertUninstallOperationsUnchanged(targetRoot, mutations);
  } catch (error) {
    await discardUninstallBackup(backupRoot, backupsDirectoryExisted);
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("UNINSTALL_TARGET_CHANGED", "卸载目标在备份后发生变化；未删除任何目标文件。", {
      cause: error.message,
    });
  }

  const applied = [];
  try {
    for (const [index, operation] of mutations.entries()) {
      await callUninstallHook(hooks, "beforeApply", { operation, index, backupRoot });
      await assertUninstallOperationUnchanged(targetRoot, operation);
      applied.push(operation);
      await rm(operation.targetPath, { force: true });
      if (operation.action === "remove-managed") {
        await writeFileAtomic(operation.targetPath, operation.content);
      }
    }
    await removeEmptyOperationDirectories(targetRoot, mutations);
  } catch (error) {
    const rollbackErrors = [];
    for (const operation of [...applied].reverse()) {
      try {
        await callUninstallHook(hooks, "beforeRollback", { operation, backupRoot });
        await assertAppliedOperationUnchanged(targetRoot, operation);
        const backupPath = path.join(backupRoot, operation.relative);
        const backupInfo = await lstat(backupPath);
        invariant(
          backupInfo.isFile() && !backupInfo.isSymbolicLink(),
          "UNINSTALL_BACKUP_INVALID",
          `卸载备份类型无效：${operation.relative}`,
        );
        const backupContent = await readFile(backupPath);
        invariant(
          hash(backupContent) === operation.snapshotHash,
          "UNINSTALL_BACKUP_INVALID",
          `卸载备份哈希无效：${operation.relative}`,
        );
        await rm(operation.targetPath, { force: true });
        await writeFileAtomic(operation.targetPath, backupContent);
      } catch (rollbackError) {
        rollbackErrors.push({ relative: operation.relative, cause: rollbackError.message });
      }
    }
    if (rollbackErrors.length > 0) {
      throw new HarnessError("UNINSTALL_ROLLBACK_FAILED", "卸载失败且回滚不完整；本次备份已保留。", {
        cause: error.message,
        backup: path.relative(targetRoot, backupRoot).replaceAll("\\", "/"),
        rollbackErrors,
      });
    }
    await discardUninstallBackup(backupRoot, backupsDirectoryExisted);
    throw new HarnessError("UNINSTALL_ROLLED_BACK", "卸载失败，已从本次备份回滚。", {
      cause: error.message,
    });
  }

  return {
    ...result,
    dryRun: false,
    backup: path.relative(targetRoot, backupRoot).replaceAll("\\", "/"),
  };
}

export async function initializeProject(root, { mode, docsMode, force = false }) {
  invariant(["new", "existing"].includes(mode), "INVALID_PROJECT_MODE", "项目模式必须是 new 或 existing。" );
  invariant(["default", "existing"].includes(docsMode), "INVALID_DOCS_MODE", "文档模式必须是 default 或 existing。" );
  const manifest = JSON.parse(await readFile(path.join(root, ".ai-harness", "manifest.json"), "utf8"));
  const projectPath = path.join(root, ".ai-harness", "project.json");
  invariant(force || !(await exists(projectPath)), "PROJECT_INITIALIZED", "项目已经初始化；如需重建必须显式使用 --force。" );
  const repository = await getGitBaseline(root);
  const project = {
    schemaVersion: 1,
    harnessVersion: manifest.version,
    mode,
    docsMode,
    initializedAt: new Date().toISOString(),
    repository,
  };
  if (mode === "new" && docsMode === "default") {
    const templateRoot = path.join(root, ".ai-harness", "templates", "new-project");
    const templateFiles = await listFiles(templateRoot);
    const conflicts = [];
    for (const relative of templateFiles) {
      const targetPath = path.join(root, relative);
      if (await exists(targetPath)) {
        const [templateContent, targetContent] = await Promise.all([
          readFile(path.join(templateRoot, relative)),
          readFile(targetPath),
        ]);
        if (hash(templateContent) !== hash(targetContent)) conflicts.push(relative);
      }
    }
    invariant(conflicts.length === 0, "DOCS_CONFLICT", "新项目默认文档与现有文件冲突；请改用 existing 文档模式或人工处理。", {
      files: conflicts,
    });
    for (const relative of templateFiles) {
      const targetPath = path.join(root, relative);
      if (!(await exists(targetPath))) await copyFileAtomic(path.join(templateRoot, relative), targetPath);
    }
  }
  await mkdir(path.join(root, ".ai-harness", "work-items"), { recursive: true });
  await atomicWriteJson(projectPath, project);
  return project;
}
