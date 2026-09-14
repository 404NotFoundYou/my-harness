import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { classifyCommand } from "../src/policy.mjs";
import { cleanup } from "./helpers.mjs";
import { commandKey, compileChecks, parseCommand } from "../src/commands.mjs";

test("version-looking arguments cannot authorize inline code or nested runtime mutations", () => {
  for (const args of [
    ["--eval", "console.log(1)", "version"], ["--eval=console.log(1)", "--version"],
    ["-econsole.log(1)", "-v"], ["version"], ["--check", "file.mjs", "--eval", "console.log(1)"],
    [".ai-harness/bin/harness.mjs", "install", "--target", "elsewhere"],
    [".ai-harness/bin/harness.mjs", "run", "--id", "X", "--", "node", "--version"],
  ]) assert.notEqual(classifyCommand("node", args).decision, "allow", JSON.stringify(args));
  assert.equal(classifyCommand("node", ["--version"]).decision, "allow");
  assert.equal(classifyCommand("node", ["--test", "sample.test.mjs"]).decision, "allow");
  assert.equal(classifyCommand("node", [".ai-harness/bin/harness.mjs", "check", "--ci"]).decision, "allow");
  assert.equal(classifyCommand("node", [null]).decision, "deny");
});

test("verification declarations become literal argument arrays without shell interpretation", () => {
  assert.deepEqual(parseCommand('node --check "中文 file.mjs"'), { command: "node", args: ["--check", "中文 file.mjs"] });
  assert.deepEqual(parseCommand(JSON.stringify({ command: "node", args: ["--test", "space & literal.test.mjs"] })), { command: "node", args: ["--test", "space & literal.test.mjs"] });
  for (const value of ["node --version && npm test", "node --version\nnode --test", 'node --check "unclosed']) {
    assert.throws(() => parseCommand(value));
  }
  assert.equal(commandKey(process.execPath, ["--version"]), commandKey("node", ["--version"]));
  assert.deepEqual(compileChecks(["node --version", "npm test"]).map((check) => check.id), ["V1", "V2"]);
});

test("an explicit verification executable cannot be replaced by a different same-named command", () => {
  for (const command of ["tools/node", "./node", "other/node.exe", "tools/npm.cmd"]) {
    assert.notEqual(commandKey(command, ["--version"]), commandKey(command.includes("npm") ? "npm" : "node", ["--version"]));
  }
  assert.notEqual(commandKey("tools/node", []), commandKey("elsewhere/node", []));
  assert.equal(commandKey(process.execPath, ["--version"]), commandKey("node", ["--version"]));
});

test("Windows package manager execution uses an explicit Node entry without a shell", async () => {
  const { resolveCommandLaunch } = await import("../src/commands.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "ai-harness-command-"));
  try {
    const bin = path.join(root, "node_modules", "npm", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(root, "npm.cmd"), "@echo fixture wrapper\r\n");
    await writeFile(path.join(bin, "npm-cli.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const args = ["run", "test", "--", "argument with spaces", "&literal"];
    const launch = await resolveCommandLaunch("npm.cmd", args, { platform: "win32", searchPath: root });
    assert.equal(launch.command, process.execPath);
    assert.equal(launch.args[0], path.join(bin, "npm-cli.js"));
    assert.deepEqual(launch.args.slice(1), args);
    const result = spawnSync(launch.command, launch.args, { shell: false, windowsHide: true, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally { await cleanup(root); }
});
