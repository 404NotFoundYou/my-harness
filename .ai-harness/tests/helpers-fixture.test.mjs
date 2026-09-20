import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { exists } from "../src/filesystem.mjs";
import { cleanup, createInstalledProject, git } from "./helpers.mjs";

test("cached installed seeds still give every test an isolated clean Git project", async () => {
  const first = await createInstalledProject();
  const second = await createInstalledProject();
  try {
    assert.notEqual(first, second);
    assert.equal(git(first, ["status", "--porcelain"]).stdout, "");
    assert.equal(git(second, ["status", "--porcelain"]).stdout, "");
    await writeFile(path.join(first, "only-first.txt"), "isolated\n");
    assert.equal(await exists(path.join(second, "only-first.txt")), false);
    assert.notEqual(git(first, ["status", "--porcelain"]).stdout, "");
    assert.equal(git(second, ["status", "--porcelain"]).stdout, "");
  } finally {
    await cleanup(first);
    await cleanup(second);
  }
});
