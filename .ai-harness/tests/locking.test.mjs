import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { inspectLock, recoverLock, withFileLock } from "../src/locking.mjs";
import { createWorkItemState, recoverWorkItemLock } from "../src/workflow.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

async function abandonedLock(directory, afterAcquire = "") {
  const lock = path.join(directory, ".lock");
  const child = path.join(directory, "exit-with-lock.mjs");
  await writeFile(child, `import { withFileLock } from ${JSON.stringify(new URL("../src/locking.mjs", import.meta.url).href)};\nimport { writeFile } from "node:fs/promises";\nawait withFileLock(${JSON.stringify(lock)}, async () => { ${afterAcquire} process.exit(0); });\n`);
  const result = spawnSync(process.execPath, [child], { shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return { lock, owner: (await inspectLock(lock)).owner };
}

test("dead owners can be recovered once without stealing a live or replacement lock", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-lock-test-"));
  try {
    const { lock, owner } = await abandonedLock(directory);
    assert.equal((await inspectLock(lock)).status, "stale");
    await assert.rejects(() => recoverLock(lock, randomUUID()), { code: "LOCK_NOT_RECOVERABLE" });
    const competing = await Promise.allSettled([recoverLock(lock, owner.token), recoverLock(lock, owner.token)]);
    assert.equal(competing.filter(result => result.status === "fulfilled").length, 1);
    await withFileLock(lock, async () => {
      const active = await inspectLock(lock);
      assert.equal(active.status, "active");
      await assert.rejects(() => recoverLock(lock, active.owner.token), { code: "LOCK_NOT_RECOVERABLE" });
      await assert.rejects(() => recoverLock(lock, owner.token), { code: "LOCK_NOT_RECOVERABLE" });
    });
    assert.equal((await inspectLock(lock)).status, "free");
    const events = [];
    await Promise.all(["a", "b"].map(id => withFileLock(lock, async () => {
      events.push(`start-${id}`); await new Promise(resolve => setTimeout(resolve, 20)); events.push(`end-${id}`);
    })));
    assert.match(events.join(","), /^(start-a,end-a,start-b,end-b|start-b,end-b,start-a,end-a)$/);
    await writeFile(lock, JSON.stringify({ pid: 1 }));
    assert.equal((await inspectLock(lock)).status, "legacy");
    await assert.rejects(() => recoverLock(lock, owner.token), { code: "LOCK_NOT_RECOVERABLE" });
    assert.equal(await readFile(lock, "utf8"), JSON.stringify({ pid: 1 }));
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-lock-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovering an interrupted work item preserves evidence and reports inconsistent writes", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, { id: "RECOVER", type: "ANALYSIS", title: "recovery", references: ["request"], acceptance: ["preserve evidence"], authorizationMode: "autonomous", authorizationSource: "fixture" });
    const directory = path.join(root, ".ai-harness/work-items/RECOVER");
    const { owner } = await abandonedLock(directory);
    const before = await readFile(path.join(directory, "state.json"), "utf8");
    const result = await recoverWorkItemLock(root, "RECOVER", { token: owner.token, reason: "fixture child exited" });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(directory, "state.json"), "utf8"), before);
    assert.match(await readFile(path.join(directory, "events.jsonl"), "utf8"), /lock-recovered/);
    const interrupted = await abandonedLock(directory, `await writeFile(${JSON.stringify(path.join(directory, "state.json"))}, "incomplete-json");`);
    await assert.rejects(() => recoverWorkItemLock(root, "RECOVER", { token: interrupted.owner.token, reason: "incomplete write fixture" }), { code: "LOCK_STATE_INCONSISTENT" });
    assert.equal(await readFile(path.join(directory, "state.json"), "utf8"), "incomplete-json");
    assert.equal((await inspectLock(path.join(directory, ".lock"))).status, "active");
  } finally { await cleanup(root); }
});

test("interrupted recovery claims remain recoverable and malformed owners stay unknown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-lock-test-"));
  try {
    const { lock, owner } = await abandonedLock(directory);
    const child = path.join(directory, "exit-during-recovery.mjs");
    await writeFile(child, `import { recoverLock } from ${JSON.stringify(new URL("../src/locking.mjs", import.meta.url).href)};\nawait recoverLock(${JSON.stringify(lock)}, ${JSON.stringify(owner.token)}, async () => { process.exit(0); });`);
    assert.equal(spawnSync(process.execPath, [child], { shell: false, windowsHide: true, timeout: 5000 }).status, 0);
    const claimed = await inspectLock(lock);
    assert.equal(claimed.status, "stale");
    assert.notEqual(claimed.owner.token, owner.token);
    await recoverLock(lock, claimed.owner.token);
    const next = await abandonedLock(directory);
    const marker = (await readdir(lock))[0];
    await writeFile(path.join(lock, marker), "null");
    assert.equal((await inspectLock(lock)).status, "unknown");
    await assert.rejects(() => recoverLock(lock, next.owner.token), { code: "LOCK_NOT_RECOVERABLE" });
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-lock-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a torn JSONL tail prevents recovery from appending or permitting another writer", async () => {
  const root = await createInstalledProject();
  try {
    await createWorkItemState(root, { id: "TORN", type: "ANALYSIS", title: "torn event", references: ["fixture"], acceptance: ["preserve original log"], authorizationMode: "autonomous", authorizationSource: "fixture" });
    const directory = path.join(root, ".ai-harness/work-items/TORN");
    const { lock, owner } = await abandonedLock(directory);
    const eventsPath = path.join(directory, "events.jsonl"), original = await readFile(eventsPath, "utf8") + '{"partial":';
    await writeFile(eventsPath, original);
    await assert.rejects(() => recoverWorkItemLock(root, "TORN", { token: owner.token, reason: "torn append fixture" }), { code: "LOCK_STATE_INCONSISTENT" });
    assert.equal(await readFile(eventsPath, "utf8"), original);
    await assert.rejects(() => withFileLock(lock, async () => assert.fail("writer must not enter"), 60), { code: "LOCK_TIMEOUT" });
  } finally { await cleanup(root); }
});

test("termination during release cleanup cannot leave an ownerless lock blocking future work", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-lock-test-"));
  try {
    const lock = path.join(directory, ".lock"), child = path.join(directory, "exit-on-unlink.mjs");
    await writeFile(child, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";\nfs.promises.unlink = async () => { process.exit(0); }; syncBuiltinESMExports();\nconst { withFileLock } = await import(${JSON.stringify(new URL("../src/locking.mjs", import.meta.url).href)});\nawait withFileLock(${JSON.stringify(lock)}, async () => {});`);
    const result = spawnSync(process.execPath, [child], { shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await inspectLock(lock)).status, "free");
    assert.ok((await readdir(directory)).some(file => file.endsWith(".tmp")), "interruption really occurred before retired-directory cleanup");
    await withFileLock(lock, async () => assert.equal((await inspectLock(lock)).status, "active"));
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-lock-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});
