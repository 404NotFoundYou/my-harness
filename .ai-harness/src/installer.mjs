import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, copyFileAtomic, exists, readJson, writeFileAtomic } from "./filesystem.mjs";
import { getGitBaseline } from "./git.mjs";
import { HarnessError, invariant } from "./errors.mjs";
import { mergeManagedFile } from "./managed-block.mjs";

const INSTRUCTION_FILES = Object.freeze([
  { relative: "AGENTS.md", compatibleImport: null },
  { relative: "CLAUDE.md", compatibleImport: "@AGENTS.md" },
  { relative: "GEMINI.md", compatibleImport: "@./AGENTS.md" },
]);

function hash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  for (const relative of await listFiles(runtimeRoot)) {
    if (relative === "project.json" || relative.startsWith("work-items/") || relative.startsWith("backups/")) continue;
    files.push(`.ai-harness/${relative}`);
  }
  if (await exists(path.join(sourceRoot, ".github", "workflows", "ai-harness.yml"))) {
    await assertSourceFile(sourceRoot, ".github/workflows/ai-harness.yml");
    files.push(".github/workflows/ai-harness.yml");
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
      operations.push({ relative, targetPath, ...merged, content: Buffer.from(merged.content), existing: false });
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
    operations.push({ relative, targetPath, ...merged, content: Buffer.from(merged.content), existing: true });
  }
  return operations;
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

export async function installRuntime(sourceRoot, target, { dryRun = false, force = false } = {}) {
  const source = await realpath(sourceRoot);
  const targetRoot = await realpath(target);
  invariant((await stat(targetRoot)).isDirectory(), "TARGET_NOT_DIRECTORY", "安装目标必须是目录。" );
  const manifest = await readJson(path.join(source, ".ai-harness", "manifest.json"));
  const files = await installationFiles(source);
  const operations = await planInstructionOperations(source, targetRoot, manifest.version, force);

  for (const relative of files) {
    const sourcePath = path.resolve(source, relative);
    const targetPath = path.resolve(targetRoot, relative);
    invariant(inside(source, sourcePath), "SOURCE_ESCAPE", `安装源路径越界：${relative}`);
    invariant(inside(targetRoot, targetPath), "TARGET_ESCAPE", `安装目标路径越界：${relative}`);
    await assertWritableParents(targetRoot, relative);
    const sourceContent = await readFile(sourcePath);
    if (!(await exists(targetPath))) {
      operations.push({ relative, action: "create", sourcePath, targetPath, sourceContent, existing: false });
      continue;
    }
    const targetInfo = await lstat(targetPath);
    invariant(targetInfo.isFile() && !targetInfo.isSymbolicLink(), "TARGET_TYPE_CONFLICT", `目标不是普通文件：${relative}`);
    const targetContent = await readFile(targetPath);
    if (hash(sourceContent) === hash(targetContent)) {
      operations.push({ relative, action: "skip", sourcePath, targetPath, existing: true });
    } else {
      operations.push({
        relative,
        action: force ? "replace" : "conflict",
        sourcePath,
        targetPath,
        sourceContent,
        targetContent,
        existing: true,
      });
    }
  }

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
