import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { exists } from "./filesystem.mjs";
import { HarnessError } from "./errors.mjs";

export function gitResult(root, args, { input = undefined, allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 32 * 1024 * 1024,
    input,
  });
  if (!allowFailure && result.status !== 0) throw new HarnessError("GIT_COMMAND_FAILED", `Git ${args[0]} 失败。`, { exitCode: result.status, error: result.error?.message || result.stderr?.trim() });
  return result;
}

const git = (root, args) => gitResult(root, args, { allowFailure: true });
const paths = (result) => (result.stdout || "").split("\0").filter(Boolean).map((file) => file.replaceAll("\\", "/"));

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
  const unstagedResult = gitResult(root, ["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none"]);
  const stagedResult = gitResult(root, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
  const untrackedResult = gitResult(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const changedFiles = new Set();
  for (const result of [unstagedResult, stagedResult, untrackedResult]) {
    if (result.status === 0) {
      for (const file of paths(result)) {
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
  const result = gitResult(root, ["diff", "--name-only", "-z", "--no-renames", `${commit}...HEAD`]);
  if (result.status !== 0) {
    return {
      files: [],
      warning: `无法读取 ${commit}...HEAD 差异：${(result.stderr || "").trim()}`,
    };
  }
  const unstaged = gitResult(root, ["diff", "--name-only", "-z", "--no-renames", "--ignore-submodules=none"]);
  const staged = gitResult(root, ["diff", "--cached", "--name-only", "-z", "--no-renames"]);
  const untracked = gitResult(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const files = new Set(paths(result));
  for (const extra of [unstaged, staged, untracked]) {
    if (extra.status === 0) {
      for (const file of paths(extra)) files.add(file);
    }
  }
  return { files: [...files].map((file) => file.replaceAll("\\", "/")).sort(), warning: null };
}
