import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { exists } from "./filesystem.mjs";

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15000,
  });
}

function text(result) {
  return (result.stdout || "").trim();
}

export async function getGitBaseline(root) {
  const isGit = await exists(`${root}/.git`);
  if (!isGit) {
    return {
      isGit: false,
      branch: null,
      commit: null,
      dirty: null,
      changedFiles: [],
    };
  }

  const branchResult = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const commitResult = git(root, ["rev-parse", "--verify", "HEAD"]);
  const unstagedResult = git(root, ["diff", "--name-only", "--diff-filter=ACMRTUXB"]);
  const stagedResult = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"]);
  const untrackedResult = git(root, ["ls-files", "--others", "--exclude-standard"]);
  const changedFiles = new Set();
  for (const result of [unstagedResult, stagedResult, untrackedResult]) {
    if (result.status === 0) {
      for (const file of text(result).split(/\r?\n/).filter(Boolean)) {
        changedFiles.add(file.replaceAll("\\", "/"));
      }
    }
  }

  const fingerprints = {};
  for (const file of changedFiles) {
    fingerprints[file] = await fileFingerprint(root, file);
  }
  return {
    isGit: true,
    branch: branchResult.status === 0 ? text(branchResult) : null,
    commit: commitResult.status === 0 ? text(commitResult) : null,
    dirty: changedFiles.size > 0,
    changedFiles: [...changedFiles].sort(),
    fingerprints,
  };
}

export async function fileFingerprint(root, relativePath) {
  try {
    const content = await readFile(`${root}/${relativePath}`);
    return createHash("sha256").update(content).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function changedFilesSince(root, commit) {
  if (!commit) return { files: [], warning: "基线没有提交 SHA，无法执行 Git 差异范围校验。" };
  const result = git(root, ["diff", "--name-only", "--diff-filter=ACMRTUXB", `${commit}...HEAD`]);
  if (result.status !== 0) {
    return {
      files: [],
      warning: `无法读取 ${commit}...HEAD 差异：${(result.stderr || "").trim()}`,
    };
  }
  const unstaged = git(root, ["diff", "--name-only", "--diff-filter=ACMRTUXB"]);
  const staged = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRTUXB"]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
  const files = new Set(text(result).split(/\r?\n/).filter(Boolean));
  for (const extra of [unstaged, staged, untracked]) {
    if (extra.status === 0) {
      for (const file of text(extra).split(/\r?\n/).filter(Boolean)) files.add(file);
    }
  }
  return { files: [...files].map((file) => file.replaceAll("\\", "/")).sort(), warning: null };
}
