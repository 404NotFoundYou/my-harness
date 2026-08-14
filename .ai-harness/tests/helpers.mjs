import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installRuntime, initializeProject } from "../src/installer.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
export const sourceRoot = path.resolve(testsDirectory, "..", "..");

export function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

export async function createInstalledProject({ mode = "existing", docsMode = "existing", commit = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ai-harness-test-"));
  await installRuntime(sourceRoot, root);
  git(root, ["init"]);
  git(root, ["config", "user.email", "harness-test@example.invalid"]);
  git(root, ["config", "user.name", "Harness Test"]);
  await initializeProject(root, { mode, docsMode });
  if (commit) {
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "test baseline"]);
  }
  return root;
}

export async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}
