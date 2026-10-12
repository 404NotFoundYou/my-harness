import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("CI keeps every supported Node line in Ubuntu and Windows coverage", async () => {
  const runtime = await readFile(path.join(root, ".github/workflows/ai-harness.yml"), "utf8");
  const source = await readFile(path.join(root, ".github/workflows/source-tests.yml"), "utf8");
  assert.match(runtime, /node-version: \["20", "22", "24"\]/);
  assert.deepEqual([...source.matchAll(/- os: (ubuntu-latest|windows-latest)\s+node-version: "(\d+)"/g)]
    .map(([, os, version]) => `${os}:${version}`).sort(),
  ["ubuntu-latest:20", "ubuntu-latest:22", "ubuntu-latest:24", "windows-latest:20", "windows-latest:22", "windows-latest:24"]);
  assert.match(runtime, /run: node \.ai-harness\/tests\/run\.mjs/);
  assert.match(runtime, /run: node \.ai-harness\/bin\/harness\.mjs check --ci --json/);
  assert.match(source, /run: node benchmarks\/tests\/run\.mjs/);
  assert.match(source, /run: node \.ai-harness\/tests\/run\.mjs/);
});

test("CI actions use a supported runtime without implicit dependency caching", async () => {
  for (const file of ["ai-harness.yml", "source-tests.yml"]) {
    const workflow = await readFile(path.join(root, ".github/workflows", file), "utf8");
    assert.deepEqual([...workflow.matchAll(/uses: actions\/(checkout|setup-node)@(\S+)/g)]
      .map(([, action, version]) => `${action}@${version}`), ["checkout@v7", "setup-node@v7"]);
    assert.match(workflow, /package-manager-cache: false/, "no dependency install should enable setup-node caching");
  }
});
