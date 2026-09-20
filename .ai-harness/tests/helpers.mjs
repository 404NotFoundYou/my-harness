import { realpathSync, rmSync } from "node:fs";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { installRuntime, initializeProject } from "../src/installer.mjs";

const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
export const sourceRoot = path.resolve(testsDirectory, "..", "..");
let defaultSeedPromise = null;
let defaultSeedRoot = null;

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

async function createFreshProject(prefix, { mode, docsMode, commit }) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
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
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function defaultSeed() {
  if (!defaultSeedPromise) {
    defaultSeedPromise = createFreshProject("ai-harness-fixture-", { mode: "existing", docsMode: "existing", commit: true })
      .then((root) => { defaultSeedRoot = root; return root; })
      .catch((error) => { defaultSeedPromise = null; throw error; });
  }
  return defaultSeedPromise;
}

process.once("exit", () => {
  if (!defaultSeedRoot) return;
  try {
    const resolved = realpathSync(defaultSeedRoot);
    const temporaryRoot = realpathSync(tmpdir());
    if (path.dirname(resolved) === temporaryRoot && path.basename(resolved).startsWith("ai-harness-fixture-")) {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    }
  } catch (error) {
    console.error(`Failed to clean cached test fixture: ${error.message}`);
    process.exitCode ||= 1;
  }
});

export async function createInstalledProject({ mode = "existing", docsMode = "existing", commit = true } = {}) {
  if (process.env.AI_HARNESS_TEST_FRESH_FIXTURES === "1" || mode !== "existing" || docsMode !== "existing" || !commit) {
    return createFreshProject("ai-harness-test-", { mode, docsMode, commit });
  }
  const root = await mkdtemp(path.join(tmpdir(), "ai-harness-test-"));
  try {
    await cp(await realpath(await defaultSeed()), root, { recursive: true });
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}
