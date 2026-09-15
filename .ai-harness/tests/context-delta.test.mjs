import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { taskContext } from "../src/context.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

test("context omits unchanged complete content but repeats changed or truncated files", async () => {
  const root = await createInstalledProject();
  const item = { input: { references: ["short.md", "long.md"] } };
  try {
    await writeFile(path.join(root, "short.md"), "original context");
    await writeFile(path.join(root, "long.md"), "x".repeat(9000));
    const first = await taskContext(root, item, null);
    assert.equal(first.manifest.files.find(file => file.path === "long.md").complete, false);
    await writeFile(path.join(root, "context.json"), JSON.stringify(first));
    const second = await taskContext(root, item, null, { since: "context.json" });
    assert.equal(second.files.find(file => file.path === "short.md").unchanged, true);
    assert.equal(second.files.find(file => file.path === "short.md").content, "");
    assert.equal(second.files.find(file => file.path === "long.md").content.length, 6000);
    await writeFile(path.join(root, "short.md"), "changed context");
    const third = await taskContext(root, item, null, { since: "context.json" });
    assert.equal(third.files.find(file => file.path === "short.md").content, "changed context");
    await writeFile(path.join(root, "context.json"), "null");
    await assert.rejects(() => taskContext(root, item, null, { since: "context.json" }), { code: "INVALID_CONTEXT_MANIFEST" });
  } finally { await cleanup(root); }
});

test("explicit multilingual files are readable and every excluded or excess path is explained", async () => {
  const root = await createInstalledProject();
  try {
    const files = ["Example.java", "value.py", "value.dart", "view.vue", "spec.json", "schema.sql", "config.yaml", "plain.txt", "excess.md"];
    for (const file of files) await writeFile(path.join(root, file), "ordinary fixture\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, ".env"), "PRIVATE_FIXTURE=hidden");
    const result = await taskContext(root, { input: { references: ["binary.bin", ".env", "missing.java", "src/**", ...files] } }, null);
    assert.deepEqual(result.files.map(file => file.path), files.slice(0, 8));
    assert.deepEqual(new Set(result.omitted.map(file => file.path)), new Set(["binary.bin", ".env", "missing.java", "src/**", "excess.md"]));
    assert.ok(result.omitted.every(file => file.reason));
    assert.equal(JSON.stringify(result).includes("PRIVATE_FIXTURE"), false);
    assert.deepEqual(result.notReturned, []);
  } finally { await cleanup(root); }
});
