import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, createInstalledProject } from "./helpers.mjs";
import { resolveProjectPath, writeFileAtomic } from "../src/filesystem.mjs";

test("an interrupted write or publish preserves the original and removes only an owned temporary file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-harness-atomic-"));
  const target = path.join(root, "state"), failure = new Error("injected storage failure");
  try {
    await writeFile(target, "original");
    async function* partial() { yield "partial"; throw failure; }
    await assert.rejects(() => writeFileAtomic(target, partial()), error => error === failure);
    assert.deepEqual(await readdir(root), ["state"]);
    t.mock.method(fsPromises, "rename", async () => { throw failure; });
    syncBuiltinESMExports();
    await assert.rejects(() => writeFileAtomic(target, "replacement"), error => error === failure);
    assert.deepEqual(await readdir(root), ["state"]);
    assert.equal(await readFile(target, "utf8"), "original");
    const open = fsPromises.open;
    let collision;
    t.mock.method(fsPromises, "open", async (file, flags) => {
      collision = file;
      await writeFile(file, "another writer");
      return open(file, flags);
    });
    syncBuiltinESMExports();
    await assert.rejects(() => writeFileAtomic(target, "replacement"), { code: "EEXIST" });
    assert.equal(await readFile(collision, "utf8"), "another writer");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await cleanup(root); }
});

test("project paths reject absolute and parent traversal", async () => {
  const root = await createInstalledProject();
  try {
    await assert.rejects(() => resolveProjectPath(root, "../outside.txt", { forWrite: true }), { code: "PATH_ESCAPE" });
    await assert.rejects(() => resolveProjectPath(root, path.resolve(root, "absolute.txt"), { forWrite: true }), { code: "ABSOLUTE_PATH" });
  } finally {
    await cleanup(root);
  }
});

test("write paths reject symlink components when the platform permits links", async (context) => {
  const root = await createInstalledProject();
  const outside = `${root}-outside`;
  try {
    await mkdir(outside, { recursive: true });
    try {
      await symlink(outside, path.join(root, "linked"), "junction");
    } catch (error) {
      context.skip(`当前平台无法创建测试链接：${error.code}`);
      return;
    }
    await assert.rejects(() => resolveProjectPath(root, "linked/file.txt", { forWrite: true }), { code: "SYMLINK_WRITE" });
  } finally {
    await cleanup(root);
    await cleanup(outside);
  }
});
