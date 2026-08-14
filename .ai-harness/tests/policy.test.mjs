import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../src/policy.mjs";
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
