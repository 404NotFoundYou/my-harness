import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, readlink, realpath } from "node:fs/promises";
import { atomicWriteJson, normalizeRelativePath, readJson, resolveProjectPath } from "./filesystem.mjs";
import { gitResult, worktreeStatus } from "./git.mjs";
import { invariant } from "./errors.mjs";

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

export function makeSnapshot(files) {
  const sorted = Object.assign(Object.create(null), Object.fromEntries(Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
  return { version: 1, digest: hash(JSON.stringify(sorted)), files: sorted };
}

export function controlPath(file, directory) {
  const prefix = normalizeRelativePath(directory).replace(/\/$/, "");
  return file === prefix || file.startsWith(`${prefix}/`);
}

function gitQuotedPath(file) {
  return '"' + file.replace(/[\x00-\x1f\x7f"\\]/g, (char) => char === '"' || char === "\\" ? `\\${char}` : `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`) + '"';
}

export async function sourceSnapshot(root) {
  const config = await readJson(path.join(root, ".ai-harness/config.json"));
  const index = gitResult(root, ["ls-files", "--stage", "-z"]).stdout.split("\0").filter(Boolean);
  const files = Object.create(null);
  for (const entry of index) {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry);
    invariant(match && match[3] === "0", "UNMERGED_SOURCE", "代码快照包含未解决的合并冲突。" );
    if (!controlPath(match[4], config.workItemsDirectory)) files[match[4]] = `${match[1]}:${match[2]}`;
  }
  const {modified,untracked}=worktreeStatus(root);
  const regular = [];
  let fileMode;
  for (const file of [...new Set([...modified, ...untracked])].sort()) {
    if (controlPath(file, config.workItemsDirectory)) continue;
    const absolute = await resolveProjectPath(root, file);
    let info;
    try { info = await lstat(absolute); } catch (error) {
      if (error.code === "ENOENT") { delete files[file]; continue; }
      throw error;
    }
    invariant(!files[file]?.startsWith("160000:"), "DIRTY_SUBMODULE", `子模块有未冻结的变更，需先记录其提交：${file}`);
    if (info.isSymbolicLink()) {
      const oid = gitResult(root, ["hash-object", "--stdin"], { input: await readlink(absolute) }).stdout.trim();
      files[file] = `120000:${oid}`;
    } else {
      invariant(info.isFile(), "UNSUPPORTED_SOURCE_FILE", `不能对非普通文件建立代码快照：${file}`);
      if(fileMode === undefined)fileMode=gitResult(root, ["config", "--bool", "core.filemode"], { allowFailure: true }).stdout.trim() !== "false";
      regular.push({ file, mode: fileMode ? (info.mode & 0o111 ? "100755" : "100644") : (files[file]?.split(":")[0] || "100644") });
    }
  }
  if (regular.length) {
    const hashes = gitResult(root, ["hash-object", "--stdin-paths"], { input: regular.map(({ file }) => gitQuotedPath(file)).join("\n") + "\n" }).stdout.trim().split(/\r?\n/);
    invariant(hashes.length === regular.length && hashes.every((oid) => /^[0-9a-f]{40,64}$/.test(oid)), "SNAPSHOT_HASH_FAILED", "Git 未返回完整的代码内容标识。" );
    regular.forEach(({ file, mode }, index) => { files[file] = `${mode}:${hashes[index]}`; });
  }
  return makeSnapshot(files);
}

export async function commitSnapshot(root, commit) {
  invariant(/^[0-9a-f]{40,64}$/.test(commit || ""), "INVALID_SNAPSHOT_COMMIT", "代码快照需要完整提交标识。" );
  const config = await readJson(path.join(root, ".ai-harness/config.json"));
  const files = Object.create(null);
  for (const entry of gitResult(root, ["ls-tree", "-r", "-z", commit]).stdout.split("\0").filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    invariant(match, "INVALID_GIT_TREE", "提交包含无法识别的文件条目。" );
    if (!controlPath(match[4], config.workItemsDirectory)) files[match[4]] = `${match[1]}:${match[3]}`;
  }
  return makeSnapshot(files);
}

export function snapshotChanges(before, after) {
  return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].filter((file) => before.files[file] !== after.files[file]).sort();
}

export async function saveSnapshot(root, directory, snapshot) {
  const originalRoot = path.resolve(root);
  const canonicalRoot = await realpath(originalRoot);
  const relativeDirectory = path.relative(originalRoot, path.resolve(directory));
  const outsideOriginal = relativeDirectory === ".." || relativeDirectory.startsWith(`..${path.sep}`) || path.isAbsolute(relativeDirectory);
  // Preserve directory components so resolveProjectPath still rejects inner links.
  const directoryFromRoot = outsideOriginal ? path.relative(canonicalRoot, path.resolve(directory)) : relativeDirectory;
  const document = path.join(directoryFromRoot, "snapshots", `${snapshot.digest}.json`).replaceAll("\\", "/");
  await atomicWriteJson(await resolveProjectPath(canonicalRoot, document, { forWrite: true }), snapshot);
  return { digest: snapshot.digest, document };
}

export async function loadSnapshot(root, reference) {
  invariant(reference && /^[0-9a-f]{64}$/.test(reference.digest || "") && typeof reference.document === "string", "SNAPSHOT_REQUIRED", "缺少可验证的代码快照引用。" );
  const snapshot = await readJson(await resolveProjectPath(root, reference.document, { mustExist: true }));
  invariant(snapshot.version === 1 && snapshot.files && typeof snapshot.files === "object" && !Array.isArray(snapshot.files), "INVALID_SNAPSHOT", "代码快照结构无效。" );
  for (const [file, value] of Object.entries(snapshot.files)) {
    normalizeRelativePath(file);
    invariant(/^\d{6}:[0-9a-f]{40,64}$/.test(value), "INVALID_SNAPSHOT", "代码快照包含无效内容标识。" );
  }
  invariant(hash(JSON.stringify(snapshot.files)) === reference.digest && snapshot.digest === reference.digest, "SNAPSHOT_HASH_MISMATCH", "代码快照内容与引用哈希不一致。" );
  snapshot.files = Object.assign(Object.create(null), snapshot.files);
  return snapshot;
}
