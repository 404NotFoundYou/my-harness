import assert from "node:assert/strict";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { resolveProjectPath } from "../.ai-harness/src/filesystem.mjs";
import { WORK_ID_PATTERN } from "../.ai-harness/src/constants.mjs";
import { projectWorkflowContract } from "./task-contract.mjs";
import { candidateDigest, validateCandidate } from "./candidates.mjs";
import { sharedDeliveryPassed } from "./statistics.mjs";
import { hash } from "./runner.mjs";
import { completedRun, parseFinal, validFinalOutput } from "./protocol.mjs";
import { readProtocolTranscript } from "./client-drivers.mjs";

export async function readExperimentFile(root, relative) {
  const absolute=await resolveProjectPath(root,relative,{forWrite:true});
  assert.equal((await lstat(absolute)).isFile(),true,"Experiment evidence must be an ordinary file");
  return readFile(absolute);
}

export async function auditTrial(directory, protocol, task, group, trial, resultText, readEvidence, protocolSha256) {
  const extended=protocol.schemaVersion>=2;
  const project=protocol.schemaVersion===3||(protocol.schemaVersion===4&&["project","project-v2"].includes(protocol.suite));
  const folder=`${task.id}-${group.id}${extended&&protocol.repetitions>1?`-trial-${trial}`:""}`;
  const raw=readEvidence || (file=>protocol.schemaVersion===4?readExperimentFile(directory,file):readFile(path.join(directory,file)));
  const read=async file=>JSON.parse((await raw(file)).toString("utf8"));
  const definition=protocol.tasks.find(entry=>entry.id===task.id);
  const row = JSON.parse(resultText ?? (await raw(`${folder}/result.json`)).toString("utf8"));
  assert.equal(row.mode, protocol.mode);
  if (row.run.finalOutput != null) {
    assert.ok(validFinalOutput(row.run.finalOutput), folder + ": invalid final output diagnostics");
    assert.equal(row.run.finalOutput.status === "valid", Boolean(parseFinal(row.run.final)), folder + ": final output diagnostics contradict normalized final");
  }
  if (extended) {
    assert.equal(row.trial, trial);
    if (protocol.mode === "real") assert.equal(row.run.completed, completedRun(row.run, row.run.final));
  }
  assert.equal(row.client || "codex", protocol.client || "codex");
  assert.equal(row.taskId, task.id);
  assert.equal(row.group, group.id);
  assert.equal(row.model, group.model);
  assert.equal(row.taskDigest, definition.taskDigest);
  assert.equal(row.judgeDigest, definition.judgeDigest);
  if (project) {
    assert.equal(row.schemaVersion,2);
    assert.equal(row.split,task.split,"trial split differs from frozen task");
    const candidate=validateCandidate(task,await read(`${folder}/candidate-files.json`));
    assert.equal(row.candidateDigest,candidateDigest(task,candidate),"candidate digest differs");
    if (Object.values(candidate.files).some(entry=>entry.status!=="present")) {
      assert.equal(row.grade.complete,false,"invalid candidate cannot complete grading");
      assert.equal(row.scope.ok,false,"invalid candidate cannot pass scope checks");
    }
  } else assert.equal(row.candidateDigest, hash(await raw(`${folder}/candidate.mjs`)));
  if (group.harness && (row.workflow?.ok || (project && row.workflow?.contract))) {
    assert.ok(Array.isArray(row.workflow.workItems) && (!row.workflow.ok || row.workflow.workItems.length > 0), "workflow work items missing");
    assert.equal(new Set(row.workflow.workItems).size, row.workflow.workItems.length, "duplicate workflow work item");
    const records = [];
    for (const id of row.workflow.workItems) {
      assert.ok(typeof id === "string" && WORK_ID_PATTERN.test(id), "invalid workflow work item");
      const prefix = `${folder}/work-items/${id}`;
      const state = await read(`${prefix}/state.json`);
      assert.equal(state.id, id, "project workflow state owner differs");
      records.push({ state, plan: state.type === "ANALYSIS" ? null : await read(`${prefix}/plan.json`) });
      if (row.workflow.ok) for (const name of ["events.jsonl", "evidence.jsonl"]) {
        const file = `${prefix}/${name}`;
        const text = (await raw(file)).toString("utf8").trim();
        assert.ok(text && text.split(/\r?\n/).every(line => JSON.parse(line).workItemId === id), `${file}: missing or foreign work item evidence`);
      }
    }
    if (project) {
      const contract=projectWorkflowContract(task,records);
      assert.deepEqual(row.workflow.contract,contract,"project workflow differs from archived state and plan");
      if (row.workflow.ok) assert.equal(contract.ok,true,"project workflow contract failed");
    }
  }
  assert.deepEqual(row.budget, protocol.budget);
  if (row.grade.complete) assert.deepEqual(row.grade.cases.map(entry=>entry.id), task.cases.map(([id])=>id));
  assert.equal(row.grade.ok, row.grade.complete && row.grade.exitCode===0 && row.grade.cases.every(entry=>entry.pass));
  if (protocol.extraTestVersion === 1) {
    const file = "test/extra.test.mjs", change = row.scope.changes.find(entry => entry.path === file);
    if (!change) assert.deepEqual(row.extraTest, { status: "not-added" });
    else if (!/^[0-9a-f]{64}$/.test(change.after)) assert.deepEqual(row.extraTest, { status: "invalid" });
    else {
      const test = row.extraTest;
      assert.equal(test.entry, file);
      assert.equal(test.sha256, change.after);
      assert.equal(test.sha256, hash(await raw(`${folder}/extra.test.mjs`)), "Extra test differs from the executed file");
      assert.ok(test.exitCode === null || Number.isInteger(test.exitCode));
      assert.ok(test.signal === null || typeof test.signal === "string");
      assert.ok(test.error === null || typeof test.error === "string");
      assert.equal(test.status, test.exitCode === 0 && !test.signal && !test.error ? "passed" : "failed");
    }
  } else assert.equal(row.extraTest, undefined, "Unexpected extra test result in legacy or project protocol");
  assert.equal(row.success, Boolean(sharedDeliveryPassed(row) && (!group.harness || row.workflow?.ok)));
  assert.equal(row.falseCompletion, Boolean(row.run.final?.completed && !row.success));
  const transcript = (await raw(`${folder}/events.jsonl`)).toString("utf8");
  if (extended && protocol.mode === "real") {
    const finalText = protocol.client === "codex" ? await raw(`${folder}/final.json`).then(bytes=>bytes.toString("utf8")).catch(error => { if (error.code === "ENOENT") return null; throw error; }) : null;
    const observed = readProtocolTranscript(protocol.client, transcript, finalText);
    for (const key of ["turnCompleted", "protocolSuccess", "unparsedLines", "errors", "warnings", "final", "usage"]) assert.deepEqual(row.run[key], observed[key], `${folder}: ${key} differs from raw protocol`);
    assert.equal(row.run.completed, completedRun({ ...row.run, ...observed }, observed.final));
  }
  if(protocol.schemaVersion===4){
    assert.deepEqual(row.execution,{protocolSha256:protocolSha256 ?? hash(await raw("protocol.json")),sourceBefore:protocol.source,sourceAfter:protocol.source},"Trial source or protocol differs");
  }
  return row;
}
