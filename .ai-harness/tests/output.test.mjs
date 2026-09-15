import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { beginWorkItem } from "../src/compact.mjs";
import { redact, runRecordedCommand } from "../src/evidence.mjs";
import { exists } from "../src/filesystem.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

const MiB = 1024 * 1024;
const runner = ".ai-harness/tests/run.mjs";

async function fixture(body, configChanges = {}) {
  const root = await createInstalledProject();
  try {
    await beginWorkItem(root, {
      id: "OUTPUT", type: "ITERATION", title: "command output evidence", references: ["test fixture"],
      acceptance: ["retain usable evidence without changing the command verdict"],
      authorizationMode: "autonomous", authorizationSource: "isolated regression fixture", risk: "medium",
      approach: "exercise the verification runner", databaseEvidence: "no external database",
      writeScopes: [runner, ".ai-harness/config.json"], verification: [`node ${runner}`],
      docsImpact: ["N/A: isolated fixture"],
    });
    // Use the installed verification entry so stdout and stderr reach the executor separately.
    await writeFile(path.join(root, runner), `import { writeSync } from "node:fs";\n${body}\n`);
    const configPath = path.join(root, ".ai-harness/config.json");
    const config = { ...JSON.parse(await readFile(configPath, "utf8")), ...configChanges };
    await writeFile(configPath, `${JSON.stringify(config)}\n`);
    return root;
  } catch (error) { await cleanup(root); throw error; }
}

const run = root => runRecordedCommand(root, { id: "OUTPUT", taskId: "T1", checkId: "V1" });

for (const exitCode of [0, 7]) {
  test(`multi-megabyte logs preserve the real command verdict (exit ${exitCode})`, async () => {
    const root = await fixture(`writeSync(1, "o".repeat(${2 * MiB})); writeSync(2, "e".repeat(${2 * MiB})); process.exitCode = ${exitCode};`);
    try {
      const event = await run(root);
      assert.equal(event.command.exitCode, exitCode);
      assert.equal(event.status, exitCode === 0 ? "pass" : "fail");
      assert.equal(event.command.failureReason, exitCode === 0 ? null : "exit-code");
      assert.equal(event.command.outputLimitExceeded, false);
      for (const [name, character] of [["stdout", "o"], ["stderr", "e"]]) {
        const captured = event.command[name];
        assert.equal(captured.bytes, 2 * MiB);
        assert.equal(captured.complete, true);
        assert.equal(captured.truncated, true);
        assert.ok(Buffer.byteLength(captured.text) < 17 * 1024);
        assert.equal(await readFile(path.join(root, captured.artifact), "utf8"), character.repeat(2 * MiB));
      }
    } finally { await cleanup(root); }
  });
}

test("the output budget is independent of preview size and applies across both streams", async () => {
  const root = await fixture('writeSync(1, "o".repeat(700000)); writeSync(2, "e".repeat(700000));', {
    maxCommandOutputBytes: MiB, maxCapturedOutputBytes: 1024,
  });
  try {
    const event = await run(root);
    assert.equal(event.status, "fail");
    assert.equal(event.command.failureReason, "output-limit");
    assert.equal(event.command.outputLimitBytes, MiB);
    assert.equal(event.command.outputLimitExceeded, true);
    assert.equal(event.command.timedOut, false);
    assert.equal(event.command.stdout.complete, false);
    assert.equal(event.command.stderr.complete, false);
  } finally { await cleanup(root); }
});

test("timeout evidence identifies partial capture without claiming an output overflow", async () => {
  const root = await fixture('writeSync(1, "started\\n"); setInterval(() => {}, 1000);', { commandTimeoutMs: 500 });
  try {
    const event = await run(root);
    assert.equal(event.status, "fail");
    assert.equal(event.command.failureReason, "timeout");
    assert.equal(event.command.timedOut, true);
    assert.equal(event.command.outputLimitExceeded, false);
    assert.equal(event.command.stdout.complete, false);
  } finally { await cleanup(root); }
});

test("unwritable output artifacts leave failed evidence and no false artifact pointer", async () => {
  const root = await fixture('writeSync(1, "o".repeat(32768)); writeSync(2, "e".repeat(32768));');
  try {
    await writeFile(path.join(root, ".ai-harness/work-items/OUTPUT/outputs"), "not a directory");
    const event = await run(root);
    assert.equal(event.status, "fail");
    assert.equal(event.command.exitCode, 0);
    assert.equal(event.command.failureReason, "output-save");
    for (const captured of [event.command.stdout, event.command.stderr]) {
      assert.equal(captured.complete, true);
      assert.ok(captured.saveError);
      assert.equal(captured.artifact, undefined);
      assert.doesNotMatch(captured.text, /see artifact/);
    }
    const recorded = (await readFile(path.join(root, ".ai-harness/work-items/OUTPUT/evidence.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line)).find(entry => entry.id === event.id);
    assert.equal(recorded.status, "fail");
    assert.equal(recorded.command.failureReason, "output-save");
  } finally { await cleanup(root); }
});

test("old configs get the new budget only when the field is absent", async () => {
  const root = await fixture(`writeSync(1, "o".repeat(${2 * MiB}));`, { maxCommandOutputBytes: undefined });
  try {
    const event = await run(root);
    assert.equal(event.status, "pass");
    assert.equal(event.command.outputLimitBytes, 16 * MiB);
    const configPath = path.join(root, ".ai-harness/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(path.join(root, runner), 'import { writeFileSync } from "node:fs"; writeFileSync("started.txt", "yes");');
    for (const budget of [null, "16777216", 0, -1, 1.5, 64 * MiB + 1]) {
      await writeFile(configPath, JSON.stringify({ ...config, maxCommandOutputBytes: budget }));
      await assert.rejects(() => run(root), { code: "INVALID_COMMAND_OUTPUT_LIMIT" });
      assert.equal(await exists(path.join(root, "started.txt")), false);
    }
  } finally { await cleanup(root); }
});

test("one failed artifact save does not discard the other stream's evidence", async (t) => {
  const root = await fixture('writeSync(1, "o".repeat(32768)); writeSync(2, "e".repeat(32768));');
  const originalWrite = fsPromises.writeFile;
  try {
    t.mock.method(fsPromises, "writeFile", async (target, ...args) => {
      if (String(target).includes("-stderr.txt.")) throw Object.assign(new Error("synthetic disk write failure"), { code: "ENOSPC" });
      return originalWrite(target, ...args);
    });
    syncBuiltinESMExports();
    const event = await run(root);
    assert.equal(event.status, "fail");
    assert.equal(event.command.failureReason, "output-save");
    assert.equal(await readFile(path.join(root, event.command.stdout.artifact), "utf8"), "o".repeat(32768));
    assert.equal(event.command.stderr.saveError.code, "ENOSPC");
    assert.equal(event.command.stderr.artifact, undefined);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await cleanup(root); }
});

test("execution errors and signals override a zero exit status", async (t) => {
  const root = await fixture('writeSync(1, "checked");');
  const originalSpawn = childProcess.spawnSync;
  try {
    for (const [code, signal, reason] of [["ENOBUFS", null, "output-limit"], ["ENOENT", null, "spawn-error"], [null, "SIGTERM", "signal"]]) {
      t.mock.method(childProcess, "spawnSync", (command, ...args) => {
        if (command !== process.execPath) return originalSpawn(command, ...args);
        return { status: 0, signal, stdout: Buffer.from("partial"), stderr: null,
          error: code ? Object.assign(new Error("synthetic process failure"), { code }) : undefined };
      });
      syncBuiltinESMExports();
      const event = await run(root);
      assert.equal(event.command.exitCode, 0);
      assert.equal(event.status, "fail");
      assert.equal(event.command.failureReason, reason);
      assert.equal(event.command.stdout.complete, false);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await cleanup(root); }
});

test("quoted credentials cut off mid-value remain redacted in preview and saved partial output", async () => {
  const secret = "fixture-value-never-persist";
  for (const key of ["TOKEN", "SECRET", "PASSWORD", "API_KEY", "PRIVATE_KEY", "API_TOKEN"]) {
    for (const ending of ['"', "'", '"tail\\', '"tail\\"escaped', '"complete"', "'complete'"]) {
      const value = `prefix\n${key}=${ending[0]}${secret}${ending.slice(1)}`;
      assert.match(redact(value), /REDACTED/);
      assert.doesNotMatch(redact(value), new RegExp(secret));
    }
  }
  const root = await fixture(`writeSync(1, "x".repeat(32768) + '\\nTOKEN="${secret}'); setInterval(() => {}, 1000);`, { commandTimeoutMs: 500 });
  try {
    const event = await run(root);
    assert.equal(event.command.failureReason, "timeout");
    assert.equal(event.command.stdout.complete, false);
    assert.doesNotMatch(event.command.stdout.text, new RegExp(secret));
    const content = await readFile(path.join(root, event.command.stdout.artifact), "utf8");
    assert.match(content, /REDACTED/);
    assert.doesNotMatch(content, new RegExp(secret));
  } finally { await cleanup(root); }
});
