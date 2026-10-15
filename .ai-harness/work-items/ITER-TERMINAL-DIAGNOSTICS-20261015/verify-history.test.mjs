import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { auditExperiment } from "../../../benchmarks/audit.mjs";
import { createComparisonReport } from "../../../benchmarks/report.mjs";
const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,"../../..");
test("new terminal diagnostics preserve every historical byte and do not invent old response observations",async()=>{
  const histories=JSON.parse(await readFile(path.join(directory,"historical-hashes.json"),"utf8"));let files=0;
  for(const history of histories)for(const[file,digest]of Object.entries(history.files)){
    assert.equal(createHash("sha256").update(await readFile(path.join(root,history.directory,file))).digest("hex"),digest,history.directory+"/"+file);files++;
  }
  assert.equal(files,498,"prior failures and inconclusive analyses must not be rewritten as new diagnostic successes");
  const outputDirectory=path.join(root,".ai-harness/work-items/MODEL-PROJECT-V2-STRUCTURED-20261014/project-v2-comparison");
  const audit=await auditExperiment(outputDirectory);
  assert.equal(audit.valid,true);assert.equal(audit.mode,"real");assert.equal(audit.samples,6);
  assert.equal(audit.groups.find(row=>row.group==="weak-baseline").completed,3);
  assert.equal(audit.groups.find(row=>row.group==="weak-harness").completed,0);
  assert.equal(audit.groups.find(row=>row.group==="weak-harness").timeouts,3);
  const report=await createComparisonReport({outputDirectory});assert.equal(report.ok,true);
  for(const pair of report.pairs)for(const side of["baseline","harness"]){
    assert.equal(pair[side].finalOutput,null,"a canonical legacy null cannot recover original file status");
    assert.equal(pair[side].timing.completion.lastAssistantMessageMs,null);
    assert.equal(pair[side].timing.completion.lastFinalResponseMs,null,"events without per-message times must remain unknown");
  }
});
