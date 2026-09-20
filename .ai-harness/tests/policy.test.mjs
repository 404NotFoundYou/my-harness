import test from "node:test";
import assert from "node:assert/strict";
import { classifyAnalysisCommand, classifyCommand } from "../src/policy.mjs";
import { redact } from "../src/evidence.mjs";

test("parse failure and nested shells are denied", () => {
  assert.equal(classifyCommand("", []).decision, "deny");
  assert.equal(classifyCommand("powershell", ["-Command", "Get-ChildItem"]).decision, "deny");
  assert.equal(classifyCommand("bash", ["-lc", "npm test"]).decision, "deny");
});

test("destructive git rules win before permissive fallbacks", () => {
  assert.equal(classifyCommand("git", ["reset", "--hard"]).decision, "deny");
  assert.equal(classifyCommand("git", ["clean", "-fd"]).decision, "deny");
  assert.equal(classifyCommand("git", ["push", "--force"]).decision, "deny");
});

test("external mutations ask while verification commands allow", () => {
  assert.equal(classifyCommand("npm", ["install", "left-pad"]).decision, "ask");
  assert.equal(classifyCommand("npm", ["publish"]).decision, "ask");
  assert.equal(classifyCommand("node", ["--test", ".ai-harness/tests"]).decision, "allow");
  assert.equal(classifyCommand("npm", ["run", "lint"]).decision, "allow");
  assert.equal(classifyCommand("unknown-tool", ["check"]).decision, "ask");
});

test("inline interpreters do not bypass command policy", () => {
  assert.equal(classifyCommand("node", ["-e", "process.exit(0)"]).decision, "ask");
  assert.equal(classifyCommand("python", ["-c", "print('ok')"]).decision, "ask");
});

test("explicit executable paths cannot impersonate an allowed tool", () => {
  assert.equal(classifyCommand("tools/node", ["--version"]).decision, "ask");
  assert.equal(classifyCommand(process.execPath, ["--version"]).decision, "allow");
});

test("evidence redacts common credentials", () => {
  const value = redact("Authorization: Bearer abc.def.ghi\nAPI_TOKEN=super-secret-value\nghp_abcdefghijklmnopqrstuvwxyz");
  assert.doesNotMatch(value, /super-secret-value/);
  assert.doesNotMatch(value, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.match(value, /REDACTED/);
});

test("ANALYSIS allows only deterministic read-only command forms", () => {
  assert.equal(classifyAnalysisCommand("node", ["--version"]).decision, "allow");
  assert.equal(classifyAnalysisCommand("node", ["--check", "sample.mjs"]).decision, "allow");
  assert.equal(classifyAnalysisCommand("node", [".ai-harness/bin/harness.mjs", "doctor", "--json"]).decision, "allow");
  assert.equal(classifyAnalysisCommand("node", ["./.ai-harness/bin/harness.mjs", "check", "--json"]).decision, "allow");
  for (const [command, args] of [
    ["node", ["--test", "sample.test.mjs"]],
    ["node", ["evil/.ai-harness/bin/harness.mjs", "doctor"]],
    ["node", [".AI-HARNESS/bin/harness.mjs", "doctor"]],
    ["npm", ["test"]],
    ["npm", ["--version"]],
    ["prettier", ["--write", "sample.mjs"]],
    ["dart", ["format", "lib"]],
  ]) {
    const result = classifyAnalysisCommand(command, args);
    assert.equal(result.decision, "deny", JSON.stringify({ command, args, result }));
    assert.equal(result.rule, "analysis-write-capable");
  }
  assert.equal(classifyAnalysisCommand("npm", ["install", "left-pad"]).decision, "ask");
  assert.equal(classifyAnalysisCommand("custom-writer", ["--version"], { additionalAllowExecutables: ["custom-writer"] }).decision, "deny");
  assert.equal(classifyAnalysisCommand("NODE", ["--version"], {}, { platform: "linux" }).decision, "deny");
  assert.equal(classifyAnalysisCommand("node", [String.raw`.ai-harness\bin\harness.mjs`, "doctor"], {}, { platform: "linux" }).decision, "deny");
  assert.equal(classifyAnalysisCommand("NODE", ["--version"], {}, { platform: "win32" }).decision, "allow");
  assert.equal(classifyAnalysisCommand("node", [String.raw`.ai-harness\bin\harness.mjs`, "doctor"], {}, { platform: "win32" }).decision, "allow");
});
