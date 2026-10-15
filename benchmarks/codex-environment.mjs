import assert from "node:assert/strict";
import path from "node:path";
import { homedir } from "node:os";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";

export const codexMemoryArguments = Object.freeze(["--disable", "memories"]);
const digest = value => createHash("sha256").update(value).digest("hex");
const portable = value => value.replaceAll("\\", "/");
export async function captureCodexEnvironment({ home = process.env.CODEX_HOME || path.join(homedir(), ".codex"), userHome = homedir(), cli } = {}) {
  home = path.resolve(home); userHome = path.resolve(userHome);
  const files = {};
  async function capture(file, recursive = false, manifest) {
    let info;
    try { info = await lstat(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      files[portable(file)] = "missing"; return;
    }
    if (info.isSymbolicLink()) { files[portable(file)] = "symlink:" + digest(await readlink(file)); return; }
    if (info.isDirectory()) {
      files[portable(file)] = "directory";
      if (recursive) for (const entry of await readdir(file, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink() || entry.name === manifest) await capture(path.join(file, entry.name), true, manifest);
      }
    } else {
      assert.ok(info.isFile(), "Environment input must be a regular file");
      files[portable(file)] = "file:" + digest(await readFile(file));
    }
  }
  for (const name of ["config.toml", "AGENTS.md", "memories/memory_summary.md", "memories/MEMORY.md"]) await capture(path.join(home, name));
  for (const [root, manifest] of [[path.join(home, "skills"), "SKILL.md"], [path.join(userHome, ".agents", "skills"), "SKILL.md"], [path.join(home, "plugins", "cache"), "plugin.json"]]) await capture(root, true, manifest);
  if (cli && /\.m?js$/i.test(cli)) await capture(path.resolve(path.dirname(cli), "../package.json"));
  const value = { version: 1, platform: process.platform, arch: process.arch, policy: "codex-memory-off", arguments: [...codexMemoryArguments], roots: { home: portable(home), userHome: portable(userHome) },
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
  return { ...value, sha256: digest(JSON.stringify(value)) };
}
export function validateCodexEnvironment(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Invalid Codex environment");
  assert.deepEqual(Object.keys(value).sort(), ["arch", "arguments", "files", "platform", "policy", "roots", "sha256", "version"]);
  assert.match(value.platform, /^[a-z0-9]+$/); assert.match(value.arch, /^[a-z0-9]+$/);
  assert.equal(value.version, 1); assert.equal(value.policy, "codex-memory-off"); assert.deepEqual(value.arguments, [...codexMemoryArguments]);
  assert.deepEqual(Object.keys(value.roots).sort(), ["home", "userHome"]);
  for (const root of Object.values(value.roots)) assert.ok(typeof root === "string" && (path.posix.isAbsolute(root) || path.win32.isAbsolute(root)));
  assert.ok(value.files && typeof value.files === "object" && !Array.isArray(value.files));
  for (const [file, identity] of Object.entries(value.files)) {
    assert.ok(path.posix.isAbsolute(file) || path.win32.isAbsolute(file));
    assert.match(identity, /^(?:missing|directory|(?:file|symlink):[0-9a-f]{64})$/);
  }
  const { sha256, ...record } = value; assert.match(sha256, /^[0-9a-f]{64}$/); assert.equal(sha256, digest(JSON.stringify(record)), "Codex environment fingerprint differs");
}
