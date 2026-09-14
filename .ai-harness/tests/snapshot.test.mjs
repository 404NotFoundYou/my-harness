import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sourceSnapshot, snapshotChanges, commitSnapshot, saveSnapshot, loadSnapshot } from "../src/snapshot.mjs";
import { changedFilesSince } from "../src/git.mjs";
import { cleanup, createInstalledProject, git } from "./helpers.mjs";

test("source identity survives staging but detects edits, deletion and renamed Unicode paths", async () => {
  const root = await createInstalledProject();
  try {
    const commit = git(root, ["rev-parse", "HEAD"]).stdout.trim();
    const initial = await sourceSnapshot(root);
    assert.equal(initial.digest, (await commitSnapshot(root, commit)).digest);
    await writeFile(path.join(root, "__proto__"), "ordinary filename\n");
    assert.ok(Object.hasOwn((await sourceSnapshot(root)).files, "__proto__"));
    await writeFile(path.join(root, "中文 file.mjs"), "const value = 1;\r\n");
    const modified = await sourceSnapshot(root);
    git(root, ["add", "中文 file.mjs"]);
    assert.equal((await sourceSnapshot(root)).digest, modified.digest);
    await rename(path.join(root, "中文 file.mjs"), path.join(root, "改名 file.mjs"));
    assert.deepEqual(snapshotChanges(modified, await sourceSnapshot(root)), ["中文 file.mjs", "改名 file.mjs"].sort());
    const changes = await changedFilesSince(root, commit);
    assert.ok(changes.files.includes("中文 file.mjs"));
    assert.ok(changes.files.includes("改名 file.mjs"));
    await rm(path.join(root, "README.md"), { force: true });
  } finally { await cleanup(root); }
});

test("control records do not stale product verification and snapshot tampering fails", async () => {
  const root = await createInstalledProject();
  try {
    const initial = await sourceSnapshot(root);
    const directory = path.join(root, ".ai-harness/work-items/SNAPSHOT");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "state.json"), "{}\n");
    assert.equal((await sourceSnapshot(root)).digest, initial.digest);
    const reference = await saveSnapshot(root, directory, initial);
    assert.equal((await loadSnapshot(root, reference)).digest, initial.digest);
    await writeFile(path.join(root, reference.document), JSON.stringify({ ...initial, files: {} }));
    await assert.rejects(() => loadSnapshot(root, reference), { code: "SNAPSHOT_HASH_MISMATCH" });
  } finally { await cleanup(root); }
});
