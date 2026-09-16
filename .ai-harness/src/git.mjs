import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { exists } from "./filesystem.mjs";
import { HarnessError, invariant } from "./errors.mjs";

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

export function worktreeStatus(root) {
  const result=gitResult(root,["--no-optional-locks","status","--porcelain=v1","-z","--untracked-files=all","--no-renames","--ignore-submodules=none"]);
  const staged=new Set(),modified=new Set(),untracked=new Set();
  for(const entry of result.stdout.split("\0").filter(Boolean)){
    const status=entry.slice(0,2),file=entry.slice(3);
    invariant(entry[2] === " "&&file&&(status === "??"||(/^[ MADTU]{2}$/.test(status)&&status !== "  ")),
      "INVALID_GIT_STATUS", "Git 未返回预期的无重命名 porcelain 状态。" );
    if(status === "??")untracked.add(file);
    else{
      if(status[0] !== " ")staged.add(file);
      if(status[1] !== " ")modified.add(file);
    }
  }
  return {staged:[...staged],modified:[...modified],untracked:[...untracked]};
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
  const status=worktreeStatus(root);
  const changedFiles = new Set();
  for(const file of [...status.modified,...status.staged,...status.untracked])changedFiles.add(file.replaceAll("\\", "/"));

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
  const status=worktreeStatus(root);
  const files = new Set(paths(result));
  for(const file of [...status.modified,...status.staged,...status.untracked])files.add(file.replaceAll("\\", "/"));
  return { files: [...files].map((file) => file.replaceAll("\\", "/")).sort(), warning: null };
}
