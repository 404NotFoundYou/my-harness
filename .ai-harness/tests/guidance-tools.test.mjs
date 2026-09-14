import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { beginWorkItem } from "../src/compact.mjs";
import { getWorkGuide } from "../src/guide.mjs";
import { runRecordedCommand } from "../src/evidence.mjs";
import { readEvidence } from "../src/verification.mjs";
import { cleanup, createInstalledProject } from "./helpers.mjs";

async function fixture(verification = ["node --check src/code.mjs"], references = ["TASK.md"]) {
  const root = await createInstalledProject();
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  for (const [file, content] of Object.entries({
    "TASK.md": "Protect the local output and caller compatibility.\n",
    "src/code.mjs": "export const value = 1;\n",
    "src/caller.mjs": 'import { value } from "./code.mjs"; export const caller = value;\n',
    "test/public.test.mjs": 'import { value } from "../src/code.mjs";\n',
    "src/broken.mjs": "const = ;\n", "src/later.mjs": "const later = 1;\n",
  })) await writeFile(path.join(root, file), content);
  await beginWorkItem(root, { id: "TOOLS", type: "ITERATION", title: "bounded guidance", references,
    acceptance: ["declared validation protects the output"], authorizationMode: "autonomous", authorizationSource: "fixture request",
    risk: "low", approach: "update the existing local implementation", databaseEvidence: "no persistence",
    writeScopes: ["src/code.mjs", "test/public.test.mjs"], verification, docsImpact: ["N/A: unchanged documentation"] });
  return root;
}

function cli(root, args, expected = 0) {
  const result = spawnSync(process.execPath, [".ai-harness/bin/harness.mjs", ...args, "--id", "TOOLS", "--json"], {
    cwd: root, shell: false, windowsHide: true, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined }, timeout: 30000,
  });
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return JSON.parse(result.stdout || result.stderr);
}

test("batch checks retain every result and expose checks left unrun after failure", async () => {
  const root = await fixture(["node --check src/code.mjs", "node --check src/broken.mjs", "node --check src/later.mjs"]);
  try {
    assert.ok((await getWorkGuide(root,"TOOLS")).next.command.args.includes("--all"));
    const failed = cli(root, ["run", "--task", "T1", "--all"], 1);
    assert.deepEqual(failed.commands.map(entry => entry.status), ["pass", "fail"]);
    assert.deepEqual(failed.notRun, ["V3"]);
    assert.equal((await readEvidence(root, "TOOLS")).filter(event=>event.kind==="command").length,2);
    await writeFile(path.join(root,"src/broken.mjs"),"const repaired = 1;\n");
    const passed = cli(root,["run","--task","T1","--all"]);
    assert.equal(passed.status,"pass");
    assert.equal(passed.commands.length,3);
    assert.deepEqual(passed.notRun,[]);
  } finally { await cleanup(root); }
});

test("batch selection cannot hide a denied command or mixed command selectors", async () => {
  const root=await fixture(["node --version", "node --eval 1", "node --check src/code.mjs"]);
  try {
    assert.equal(cli(root,["run","--task","T1","--all","--check","V1"],1).code,"CONFLICTING_CHECK_SELECTION");
    assert.equal((await readEvidence(root,"TOOLS")).length,0);
    const result=cli(root,["run","--task","T1","--all"],1);
    assert.equal(result.commands.length,1);
    assert.equal(result.blockedCheck.code,"COMMAND_REQUIRES_APPROVAL");
    assert.deepEqual(result.notRun,["V2","V3"]);
  } finally { await cleanup(root); }
});

test("optional context recovers local callers and tests with bounds and no state writes", async () => {
  const root=await fixture(["node --test test/public.test.mjs"],["TASK.md","../outside.md"]);
  try {
    const token="sk-"+"testonly".repeat(8);
    await writeFile(path.join(root,"src/code.mjs"),`export const value = "${token}";\n${"// context\n".repeat(900)}`);
    const statePath=path.join(root,".ai-harness/work-items/TOOLS/state.json");
    const before=await readFile(statePath,"utf8");
    const guide=await getWorkGuide(root,"TOOLS",{includeContext:true});
    assert.deepEqual(guide.context.files.map(file=>file.path).sort(),["TASK.md","src/caller.mjs","src/code.mjs","test/public.test.mjs"]);
    assert.ok(guide.context.files.some(file=>file.truncated));
    assert.ok(guide.context.omitted.some(file=>file.reason==="PATH_ESCAPE"));
    assert.equal(JSON.stringify(guide).includes(token),false);
    assert.equal(await readFile(statePath,"utf8"),before);
    assert.equal((await getWorkGuide(root,"TOOLS")).context,undefined);
    assert.deepEqual(guide.shortcuts,[]);
  } finally { await cleanup(root); }
});

test("verified iterations offer an auditable finish and reopened tasks show the actual next state", async () => {
  const root=await fixture();
  try {
    const event=await runRecordedCommand(root,{id:"TOOLS",taskId:"T1",checkId:"V1"});
    const guide=await getWorkGuide(root,"TOOLS");
    assert.equal(guide.shortcuts[0].code,"finish-iteration");
    assert.equal(guide.shortcuts[0].requiresJudgment,true);
    assert.ok(guide.shortcuts[0].command.args.includes(event.id));
    await writeFile(path.join(root,"src/code.mjs"),"export const value = 2;\n");
    assert.deepEqual((await getWorkGuide(root,"TOOLS")).shortcuts,[]);
    const reopened=cli(root,["reopen","--reason","explicit whole-task recovery"]);
    assert.equal(reopened.tasks[0].status,"READY");
    assert.equal(reopened.next.taskTarget,"IN_PROGRESS");
    assert.ok(reopened.next.command.args.includes("task-update"));
  } finally { await cleanup(root); }
});
