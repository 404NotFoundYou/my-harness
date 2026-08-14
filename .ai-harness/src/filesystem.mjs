import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HarnessError, invariant } from "./errors.mjs";

const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 5000;

export async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start);
  while (true) {
    if (await exists(path.join(current, ".ai-harness", "manifest.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new HarnessError(
        "ROOT_NOT_FOUND",
        "未找到 .ai-harness/manifest.json；请在已安装 Harness 的项目内运行。",
      );
    }
    current = parent;
  }
}

export function normalizeRelativePath(relativePath) {
  invariant(
    typeof relativePath === "string" && relativePath.trim().length > 0,
    "INVALID_PATH",
    "路径不能为空。",
  );
  invariant(!path.isAbsolute(relativePath), "ABSOLUTE_PATH", "只允许项目根内相对路径。", {
    path: relativePath,
  });
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  invariant(
    normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../"),
    "PATH_ESCAPE",
    "路径不能包含父目录逃逸。",
    { path: relativePath },
  );
  invariant(!normalized.includes("\0"), "INVALID_PATH", "路径包含空字符。", {
    path: relativePath,
  });
  return normalized;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveProjectPath(
  root,
  relativePath,
  { forWrite = false, mustExist = false } = {},
) {
  const normalized = normalizeRelativePath(relativePath);
  const absoluteRoot = await realpath(path.resolve(root));
  const candidate = path.resolve(absoluteRoot, normalized);
  invariant(isInside(absoluteRoot, candidate), "PATH_ESCAPE", "目标路径超出项目根。", {
    path: relativePath,
  });

  const segments = normalized.split("/").filter(Boolean);
  let cursor = absoluteRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (forWrite) {
        invariant(
          !info.isSymbolicLink(),
          "SYMLINK_WRITE",
          "写入路径不能经过符号链接或联接。",
          { path: relativePath, component: cursor },
        );
      }
      const resolved = await realpath(cursor);
      invariant(isInside(absoluteRoot, resolved), "PATH_ESCAPE", "路径解析后超出项目根。", {
        path: relativePath,
      });
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }

  if (mustExist) {
    invariant(await exists(candidate), "PATH_NOT_FOUND", "目标路径不存在。", {
      path: relativePath,
    });
  }
  return candidate;
}

export async function readJson(target) {
  let raw;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new HarnessError("FILE_NOT_FOUND", `文件不存在：${target}`);
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new HarnessError("INVALID_JSON", `JSON 无法解析：${target}`, {
      cause: error.message,
    });
  }
}

export async function atomicWriteJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function appendJsonLine(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withFileLock(lockPath, action, timeoutMs = LOCK_TIMEOUT_MS) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - startedAt >= timeoutMs) {
        throw new HarnessError("LOCK_TIMEOUT", "等待工作项锁超时；未修改任何状态。", {
          lockPath,
          timeoutMs,
        });
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export async function copyFileAtomic(source, target) {
  const content = await readFile(source);
  return writeFileAtomic(target, content);
}

export async function writeFileAtomic(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  await writeFile(temporary, content, { flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
