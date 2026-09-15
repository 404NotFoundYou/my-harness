import { lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { HarnessError, invariant } from "./errors.mjs";

const ownerName = token => `owner-${token}.json`;
const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const tokenPattern = new RegExp(`^${uuidPattern}$`);
const markerPattern = new RegExp(`^(?:owner-(${uuidPattern})|claim-(${uuidPattern})-([1-9]\\d*)-(${uuidPattern}))\\.json$`);

export async function inspectLock(lockPath) {
  let info;
  try { info = await lstat(lockPath); } catch (error) {
    if (error.code === "ENOENT") return { status: "free", owner: null };
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { status: info.isFile() ? "legacy" : "unknown", owner: null };
  try {
    const entries = await readdir(lockPath);
    if (entries.length !== 1) return { status: "unknown", owner: null };
    const match = markerPattern.exec(entries[0]);
    if (!match) return { status: "unknown", owner: null };
    const originalToken = match[1] || match[2], token = match[4] || originalToken;
    if (!tokenPattern.test(token) || !tokenPattern.test(originalToken)) return { status: "unknown", owner: null };
    const ownerPath = path.join(lockPath, entries[0]);
    const ownerInfo = await lstat(ownerPath);
    if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.size > 4096) return { status: "unknown", owner: null };
    const stored = JSON.parse(await readFile(ownerPath, "utf8"));
    if (!stored || Array.isArray(stored) || stored.version !== 2 || stored.token !== originalToken || !Number.isSafeInteger(stored.pid) || stored.pid <= 0 || typeof stored.hostname !== "string" || !Number.isFinite(Date.parse(stored.createdAt))) return { status: "unknown", owner: null };
    const owner = { version: 2, hostname: stored.hostname, createdAt: stored.createdAt, token, pid: match[3] ? Number(match[3]) : stored.pid };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return { status: "unknown", owner: null };
    const details = { owner, file: entries[0], originalToken };
    if (owner.hostname !== hostname()) return { status: "foreign", ...details };
    try { process.kill(owner.pid, 0); return { status: "active", ...details }; } catch (error) {
      return { status: error.code === "ESRCH" ? "stale" : "unknown", ...details };
    }
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return { status: "changed", owner: null };
    if (error instanceof SyntaxError) return { status: "unknown", owner: null };
    throw error;
  }
}

async function releaseOwner(lockPath, file, token) {
  // 活所有者先整体移走目录。清理中断只留下不参与互斥的临时目录。
  const retired = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${token}.${randomUUID()}.tmp`);
  await rename(lockPath, retired);
  await unlink(path.join(retired, file));
  await rmdir(retired);
}

export async function recoverLock(lockPath, token, action = async () => undefined) {
  invariant(typeof token === "string" && tokenPattern.test(token), "LOCK_TOKEN_REQUIRED", "恢复需要 lock-status 返回的所有者 token。" );
  const current = await inspectLock(lockPath);
  invariant(current.status === "stale" && current.owner.token === token, "LOCK_NOT_RECOVERABLE", "只能恢复同机、确定已退出且 token 匹配的所有者锁；旧格式或未知锁不能自动回收。", current);
  const claimToken = randomUUID(), claimFile = `claim-${current.originalToken}-${process.pid}-${claimToken}.json`;
  // 原子认领唯一代次；竞争恢复者只能重命名旧文件，不能移走新锁目录。
  try { await rename(path.join(lockPath, current.file), path.join(lockPath, claimFile)); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) throw new HarnessError("LOCK_CHANGED", "锁已被其他恢复操作处理；请重新读取状态。" );
    throw error;
  }
  // 检查失败保留认领锁及原始记录，禁止等待中的写入提前进入损坏控制面。
  const result = await action(current.owner);
  await releaseOwner(lockPath, claimFile, claimToken);
  return { recovered: true, owner: current.owner, result };
}

export async function withFileLock(lockPath, action, timeoutMs = 5000) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const owner = { version: 2, pid: process.pid, hostname: hostname(), token: randomUUID(), createdAt: new Date().toISOString() };
  const temporary = path.join(path.dirname(lockPath), `.${path.basename(lockPath)}.${owner.token}.tmp`);
  await mkdir(temporary);
  let published = false;
  try {
    await writeFile(path.join(temporary, ownerName(owner.token)), JSON.stringify(owner), { flag: "wx" });
    const startedAt = Date.now();
    while (!published) {
      const current = await inspectLock(lockPath);
      if (current.status === "free") {
        try { await rename(temporary, lockPath); published = true; } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(error.code) || (await inspectLock(lockPath)).status === "free") throw error;
        }
      }
      if (published) break;
      if (Date.now() - startedAt >= timeoutMs) throw new HarnessError("LOCK_TIMEOUT", "等待工作项锁超时；未修改任何状态。可用 lock-status 查看是否需要恢复。", { lockPath, timeoutMs, lock: await inspectLock(lockPath) });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return await action();
  } finally {
    if (published) await releaseOwner(lockPath, ownerName(owner.token), owner.token);
    else {
      await unlink(path.join(temporary, ownerName(owner.token))).catch(error => { if (error.code !== "ENOENT") throw error; });
      await rmdir(temporary);
    }
  }
}
