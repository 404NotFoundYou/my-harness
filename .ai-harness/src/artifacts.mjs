import path from "node:path";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { exists, normalizeRelativePath, readJson, resolveProjectPath, writeFileAtomic } from "./filesystem.mjs";
import { invariant } from "./errors.mjs";

const maxBytes = 16 * 1024 * 1024;
const hash = content => createHash("sha256").update(content).digest("hex");

async function contentAt(root, relative) {
  const absolute = await resolveProjectPath(root, relative, { forWrite: true, mustExist: true });
  const handle = await open(absolute, "r");
  try {
    const info = await handle.stat();
    invariant(info.isFile() && info.size <= maxBytes, "ARTIFACT_SIZE", "产物必须是 16 MiB 以内的普通文件。" );
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    invariant(offset === info.size, "ARTIFACT_CHANGED", "产物读取期间发生大小变化，请等待生成完成后再记录。" );
    return buffer.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function captureArtifacts(root, id, paths, source) {
  invariant(Array.isArray(paths) && paths.length > 0 && paths.length <= 8 && typeof source === "string" && source.trim(), "ARTIFACT_SOURCE_REQUIRED", "产物需要 1 到 8 个路径和实际执行来源说明。" );
  const normalized = paths.map(normalizeRelativePath);
  invariant(new Set(normalized).size === normalized.length, "ARTIFACT_DUPLICATE", "产物路径不能重复。" );
  const config = await readJson(path.join(root, ".ai-harness/config.json"));
  const candidates = [];
  for (const original of normalized) {
    invariant(!/(?:^|\/)(?:\.git|\.env(?:\.[^/]*)?)(?:\/|$)|\.(?:key|pem|p12|pfx)$/i.test(original), "ARTIFACT_SENSITIVE_PATH", "不能把凭据或 Git 元数据作为产物归档。" );
    const content = await contentAt(root, original), sha256 = hash(content);
    const extension = /^\.[a-z0-9]{1,10}$/i.test(path.extname(original)) ? path.extname(original) : ".bin";
    const document = `${normalizeRelativePath(config.workItemsDirectory).replace(/\/+$/, "")}/${id}/artifacts/${sha256}${extension}`;
    candidates.push({ content, reference: { version: 1, path: document, sha256, bytes: content.length, source: source.trim() } });
  }
  for (const { content, reference } of candidates) {
    const destination = await resolveProjectPath(root, reference.path, { forWrite: true });
    if (await exists(destination)) invariant(hash(await contentAt(root, reference.path)) === reference.sha256, "ARTIFACT_HASH_MISMATCH", "已有产物副本被修改，不能静默覆盖。" );
    else await writeFileAtomic(destination, content);
  }
  return candidates.map(entry => entry.reference);
}

export async function assertArtifacts(root, id, references) {
  if (references === undefined) return;
  invariant(Array.isArray(references) && references.length > 0 && references.length <= 8, "ARTIFACT_INVALID", "产物引用数组无效。" );
  const config = await readJson(path.join(root, ".ai-harness/config.json"));
  const prefix = `${normalizeRelativePath(config.workItemsDirectory).replace(/\/+$/, "")}/${id}/artifacts/`;
  for (const reference of references) {
    invariant(reference?.version === 1 && typeof reference.path === "string" && normalizeRelativePath(reference.path).startsWith(prefix) && /^[0-9a-f]{64}$/.test(reference.sha256 || "") && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && typeof reference.source === "string" && reference.source.trim(), "ARTIFACT_INVALID", "产物必须归属当前工作项并具有有效版本、哈希、大小和来源。" );
    const content = await contentAt(root, reference.path);
    invariant(content.length === reference.bytes && hash(content) === reference.sha256, "ARTIFACT_HASH_MISMATCH", "归档产物与证据哈希不一致。" );
  }
}
