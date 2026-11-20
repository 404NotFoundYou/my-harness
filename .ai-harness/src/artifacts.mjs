import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
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

export async function assertArtifacts(root, id, references, config) {
  if (references === undefined) return;
  invariant(Array.isArray(references) && references.length > 0 && references.length <= 8, "ARTIFACT_INVALID", "产物引用数组无效。" );
  config ??= await readJson(path.join(root, ".ai-harness/config.json"));
  const prefix = `${normalizeRelativePath(config.workItemsDirectory).replace(/\/+$/, "")}/${id}/artifacts/`;
  for (const reference of references) {
    invariant(reference?.version === 1 && typeof reference.path === "string" && normalizeRelativePath(reference.path).startsWith(prefix) && /^[0-9a-f]{64}$/.test(reference.sha256 || "") && Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && typeof reference.source === "string" && reference.source.trim(), "ARTIFACT_INVALID", "产物必须归属当前工作项并具有有效版本、哈希、大小和来源。" );
    const content = await contentAt(root, reference.path);
    invariant(content.length === reference.bytes && hash(content) === reference.sha256, "ARTIFACT_HASH_MISMATCH", "归档产物与证据哈希不一致。" );
  }
}

export async function assertEvidenceArtifacts(root, id, event, config) {
  await assertArtifacts(root, id, event.artifacts, config);
  if (event.kind !== "command") return;
  let directory;
  for (const name of ["stdout", "stderr"]) {
    const stream = event.command?.[name];
    if (event.command?.outputLimitBytes !== undefined) {
      invariant(typeof stream?.truncated === "boolean" && typeof stream.complete === "boolean",
        "OUTPUT_ARTIFACT_INVALID", `命令缺少 ${name} 的输出捕获记录。`);
    }
    if (stream?.artifact === undefined && stream?.artifactSha256 === undefined) {
      // Older runners stored only a preview. Modern truncated streams must account for the archive.
      invariant(!stream?.truncated || (stream.complete === undefined && event.command.outputLimitBytes === undefined) ||
        (event.status === "fail" && stream.saveError?.code), "OUTPUT_ARTIFACT_INVALID", `截断的 ${name} 缺少归档引用。`);
      continue;
    }
    directory ??= normalizeRelativePath((config ?? await readJson(path.join(root, ".ai-harness/config.json"))).workItemsDirectory);
    const expected = path.posix.join(directory, id, "outputs", `${event.id}-${name}.txt`);
    invariant(/^[a-zA-Z0-9-]+$/.test(event.id) && stream.artifact === expected && /^[0-9a-f]{64}$/.test(stream.artifactSha256 || ""),
      "OUTPUT_ARTIFACT_INVALID", `${name} 的归档路径或摘要与本工作项、命令或输出流不匹配。`);
    const file = await resolveProjectPath(root, expected, { forWrite: true, mustExist: true });
    invariant((await lstat(file)).isFile(), "OUTPUT_ARTIFACT_INVALID", `命令日志必须是普通文件：${expected}`);
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    invariant(digest.digest("hex") === stream.artifactSha256, "OUTPUT_ARTIFACT_HASH_MISMATCH", `命令日志内容与归档摘要不一致：${expected}`);
  }
}
