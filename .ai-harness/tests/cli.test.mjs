import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { cleanup, git, sourceRoot } from "./helpers.mjs";

const sourceEntrypoint = path.join(sourceRoot, ".ai-harness", "bin", "harness.mjs");

function runCli(entrypoint, cwd, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(
    result.status,
    expectedStatus,
    `CLI ${args.join(" ")} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return result;
}

function jsonOutput(result, stream = "stdout") {
  return JSON.parse(result[stream]);
}

test("CLI guard uses stable allow, ask and deny exit codes", () => {
  assert.equal(runCli(sourceEntrypoint, sourceRoot, ["guard", "--", "node", "--version"], 0).status, 0);
  assert.equal(runCli(sourceEntrypoint, sourceRoot, ["guard", "--", "npm", "install", "left-pad"], 2).status, 2);
  assert.equal(runCli(sourceEntrypoint, sourceRoot, ["guard", "--", "git", "reset", "--hard"], 3).status, 3);
});

test("installed CLI completes an iteration and passes its CI gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-harness-cli-"));
  try {
    const installed = jsonOutput(runCli(sourceEntrypoint, sourceRoot, ["install", "--target", root, "--json"]));
    assert.ok(installed.operations.some((operation) => operation.relative === "AGENTS.md" && operation.action === "create"));
    const entrypoint = path.join(root, ".ai-harness", "bin", "harness.mjs");

    git(root, ["init"]);
    git(root, ["config", "user.email", "harness-test@example.invalid"]);
    git(root, ["config", "user.name", "Harness Test"]);
    runCli(entrypoint, root, ["init", "--mode", "existing", "--docs", "existing", "--json"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "installed runtime"]);

    const doctor = jsonOutput(runCli(entrypoint, root, ["doctor", "--json"]));
    assert.equal(doctor.ok, true);
    assert.equal("fingerprints" in doctor.details.repository, false);

    const invalid = jsonOutput(runCli(entrypoint, root, [
      "start", "--id", "NEW-INVALID", "--type", "NEW_PROJECT", "--title", "missing architecture",
      "--input", "approved PRD", "--acceptance", "project boots",
      "--authorization-source", "test authorization", "--json",
    ], 1), "stderr");
    assert.equal(invalid.code, "ARCHITECTURE_SOURCE_REQUIRED");

    const id = "ITER-CLI";
    runCli(entrypoint, root, [
      "start", "--id", id, "--type", "ITERATION", "--title", "CLI workflow",
      "--input", "approved PRD", "--acceptance", "all gates pass",
      "--authorization", "autonomous", "--authorization-source", "test authorization",
      "--flag", "api", "--json",
    ]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "BASELINING", "--json"]);
    runCli(entrypoint, root, ["baseline", "--id", id, "--evidence", "clean Git baseline", "--json"]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "SOLUTION_DESIGN", "--json"]);
    await writeFile(path.join(root, "solution.md"), "# Solution\n\nNo database changes.\n", "utf8");
    runCli(entrypoint, root, ["solution", "--id", id, "--document", "solution.md", "--evidence", "API flow designed", "--json"]);
    runCli(entrypoint, root, ["database", "--id", id, "--impact", "none", "--evidence", "no persistence changes", "--json"]);
    runCli(entrypoint, root, ["plan-init", "--id", id, "--mode", "single", "--rationale", "one bounded module", "--json"]);
    runCli(entrypoint, root, [
      "batch-add", "--id", id, "--batch", "R1", "--title", "CLI batch", "--risk", "medium", "--json",
    ]);
    runCli(entrypoint, root, [
      "task-add", "--id", id, "--task", "T1", "--title", "verify CLI", "--module", "runtime",
      "--writes", "solution.md", "--verify", "node --version", "--docs", "N/A: no user documentation change",
      "--batch", "R1", "--risk", "medium", "--owner", "test", "--json",
    ]);
    runCli(entrypoint, root, ["plan-approve", "--id", id, "--approval-ref", "test authorization", "--json"]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "PLANNED", "--json"]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "IMPLEMENTING", "--json"]);
    const prematureCommand = jsonOutput(runCli(entrypoint, root, [
      "run", "--id", id, "--task", "T1", "--json", "--", process.execPath, "--version",
    ], 1), "stderr");
    assert.equal(prematureCommand.code, "WRONG_TASK_STAGE");
    runCli(entrypoint, root, ["task-update", "--id", id, "--task", "T1", "--status", "IN_PROGRESS", "--json"]);
    const command = jsonOutput(runCli(entrypoint, root, ["run", "--id", id, "--task", "T1", "--json", "--", process.execPath, "--version"]));
    assert.equal(command.status, "pass");
    runCli(entrypoint, root, [
      "record", "--id", id, "--task", "T1", "--kind", "verification", "--status", "pass",
      "--evidence", `command ${command.id}`, "--json",
    ]);
    runCli(entrypoint, root, ["task-update", "--id", id, "--task", "T1", "--status", "IMPLEMENTED", "--json"]);
    runCli(entrypoint, root, ["task-update", "--id", id, "--task", "T1", "--status", "IN_REVIEW", "--json"]);
    runCli(entrypoint, root, [
      "record", "--id", id, "--task", "T1", "--kind", "review", "--status", "pass",
      "--evidence", "task diff reviewed", "--json",
    ]);
    runCli(entrypoint, root, ["task-update", "--id", id, "--task", "T1", "--status", "COMPLETED", "--json"]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "VERIFYING", "--json"]);
    runCli(entrypoint, root, ["record", "--id", id, "--kind", "verification", "--status", "pass", "--evidence", "full verification passed", "--json"]);
    runCli(entrypoint, root, ["record", "--id", id, "--kind", "documentation", "--status", "not-applicable", "--evidence", "no documentation behavior changed", "--json"]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "CODE_REVIEW", "--json"]);
    runCli(entrypoint, root, ["record", "--id", id, "--kind", "review", "--status", "pass", "--evidence", "final diff reviewed", "--json"]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "READY_FOR_ACCEPTANCE", "--json"]);
    runCli(entrypoint, root, ["record", "--id", id, "--kind", "acceptance", "--status", "pass", "--evidence", "authorized acceptance", "--json"]);
    runCli(entrypoint, root, ["transition", "--id", id, "--to", "DONE", "--json"]);

    const checked = jsonOutput(runCli(entrypoint, root, ["check", "--ci", "--json"]));
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.errors, []);
  } finally {
    await cleanup(root);
  }
});
