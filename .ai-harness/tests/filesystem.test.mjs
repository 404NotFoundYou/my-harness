import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { cleanup, createInstalledProject } from "./helpers.mjs";
import { resolveProjectPath } from "../src/filesystem.mjs";

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
