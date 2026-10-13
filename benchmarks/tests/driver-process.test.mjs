import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { clientDriver } from "../client-drivers.mjs";

const toolEvent = client => client === "codex"
  ? { type: "item.started", item: { type: "command_execution", id: "tool-1" } }
  : client === "claude"
    ? { type: "assistant", message: { content: [{ type: "tool_use", id: "tool-1" }] } }
    : { type: "tool_use", tool_id: "tool-1" };

async function cleanupFixture(directory) {
  const resolved = await realpath(directory);
  assert.equal(path.dirname(resolved), await realpath(tmpdir()));
  assert.ok(path.basename(resolved).startsWith("ai-harness-driver-process-"));
  await rm(resolved, { recursive: true, force: true });
}

for (const client of ["codex", "claude", "gemini"]) {
  for (const scenario of ["timeout", "tool-limit", "leader-exit"]) {
    test(client + " budget cutoff owns the process group after " + scenario, async (context) => {
      const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-driver-process-"));
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const child = new EventEmitter();
      child.pid = 123456;
      child.exitCode = scenario === "leader-exit" ? 0 : null;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      let closed = false, options;
      const groups = [];
      const close = () => {
        if (closed) return;
        closed = true;
        child.exitCode ??= 1;
        child.stdout.end(); child.stderr.end();
        child.emit("close", child.exitCode);
      };
      child.kill = () => { close(); return true; };
      const watchdog = setTimeout(close, 250);
      try {
        Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
        context.mock.method(childProcess, "spawn", (_command, _args, spawnOptions) => {
          options = spawnOptions;
          if (scenario === "tool-limit") queueMicrotask(() => child.stdout.write(JSON.stringify(toolEvent(client)) + "\n"));
          return child;
        });
        context.mock.method(process, "kill", (pid, signal) => { groups.push({ pid, signal }); close(); return true; });
        syncBuiltinESMExports();
        const result = await clientDriver(client, "fixture.mjs")({ root: directory, model: "synthetic", prompt: "No model calls",
          budget: { timeoutMs: 20, maxToolCalls: scenario === "tool-limit" ? 1 : 10 }, outputDirectory: directory });
        assert.equal(options.detached, true, "the owned CLI and tools must share an isolated POSIX process group");
        assert.deepEqual(groups, [{ pid: -child.pid, signal: "SIGKILL" }],
          "cutoff must also close tool pipes when the CLI leader has already exited");
        assert.equal(scenario === "tool-limit" ? result.toolLimit : result.timedOut, true);
        assert.equal(result.completed, false, "budget cancellation can never count as successful completion");
      } finally {
        clearTimeout(watchdog);
        Object.defineProperty(process, "platform", descriptor);
        context.mock.restoreAll(); syncBuiltinESMExports();
        await cleanupFixture(directory);
      }
    });
  }
}

for (const client of ["codex", "claude", "gemini"]) {
  for (const scenario of ["timeout", "tool-limit", "leader-exit"]) {
    test(client + " cutoff closes real descendant pipes after " + scenario, { skip: process.platform === "win32", timeout: 10000 }, async (context) => {
      const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-driver-process-"));
      const cli = path.join(directory, "fixture.mjs");
      const tool = 'require("node:fs").writeFileSync("tool.pid", String(process.pid)); process.send("ready"); ' +
        'setTimeout(() => require("node:fs").writeFileSync("after-budget.txt", "unexpected tool write"), 3000); setInterval(() => {}, 1000);';
      const event = scenario === "tool-limit" ? toolEvent(client) : { type: "system" };
      let watchdogError = null, cliChild = null;
      const spawn = childProcess.spawn;
      context.mock.method(childProcess, "spawn", (...args) => { cliChild = spawn(...args); return cliChild; });
      syncBuiltinESMExports();
      const watchdog = setTimeout(async () => {
        try {
          let groupStopped = false;
          if (cliChild?.pid) {
            try { process.kill(-cliChild.pid, "SIGKILL"); groupStopped = true; }
            catch (error) { if (error.code !== "ESRCH") throw error; }
            if (!groupStopped && cliChild.exitCode === null) cliChild.kill("SIGKILL");
          }
          if (!groupStopped) {
            const pid = Number(await readFile(path.join(directory, "tool.pid"), "utf8"));
            assert.ok(Number.isSafeInteger(pid) && pid > 0);
            try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        } catch (error) { watchdogError = error; }
      }, 5000);
      try {
        await writeFile(cli, 'import { spawn } from "node:child_process";\n' +
          'const tool = spawn(process.execPath, ["-e", ' + JSON.stringify(tool) + '], { stdio: ["ignore", "inherit", "inherit", "ipc"] });\n' +
          'tool.once("message", () => process.stdout.write(' + JSON.stringify(JSON.stringify(event) + "\n") +
            ', () => { ' + (scenario === "leader-exit" ? 'process.exit(0);' : '') + ' }));\nsetInterval(() => {}, 1000);\n');
        const result = await clientDriver(client, cli)({ root: directory, model: "synthetic", prompt: "No model calls",
          budget: { timeoutMs: 2000, maxToolCalls: scenario === "tool-limit" ? 1 : 10 }, outputDirectory: directory });
        assert.equal(watchdogError, null);
        assert.ok(result.durationMs < 4000, "descendants must close their inherited pipes before the fixture rescue deadline");
        const wroteAfterCutoff = await readFile(path.join(directory, "after-budget.txt"), "utf8")
          .then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
        assert.equal(wroteAfterCutoff, false, "tools cannot write after the driver starts grading or cleanup");
        assert.equal(scenario === "tool-limit" ? result.toolLimit : result.timedOut, true);
        assert.equal(result.completed, false);
      } finally {
        clearTimeout(watchdog);
        context.mock.restoreAll(); syncBuiltinESMExports();
        await cleanupFixture(directory);
      }
    });
  }
}
