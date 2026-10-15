import test from "node:test";import assert from "node:assert/strict";import path from "node:path";import{fileURLToPath}from"node:url";import{readFile}from"node:fs/promises";import{createHash}from"node:crypto";
import{auditExperiment}from"../../../benchmarks/audit.mjs";import{createComparisonReport}from"../../../benchmarks/report.mjs";
const directory=path.dirname(fileURLToPath(import.meta.url)),root=path.resolve(directory,"../../..");
test("memory controls preserve all historical bytes and do not invent environment evidence for old experiments",async()=>{
 const histories=JSON.parse(await readFile(path.join(directory,"historical-hashes.json"),"utf8"));let count=0;
 for(const history of histories)for(const[file,digest]of Object.entries(history.files)){assert.equal(createHash("sha256").update(await readFile(path.join(root,history.directory,file))).digest("hex"),digest,history.directory+"/"+file);count++;}
 assert.equal(count,514);const outputDirectory=path.join(root,".ai-harness/work-items/MODEL-PROJECT-V2-STRUCTURED-20261014/project-v2-comparison");
 const audit=await auditExperiment(outputDirectory);assert.equal(audit.valid,true);assert.equal(audit.samples,6);
 assert.equal(audit.groups.find(row=>row.group==="weak-baseline").completed,3);assert.equal(audit.groups.find(row=>row.group==="weak-harness").completed,0);
 const report=await createComparisonReport({outputDirectory});assert.equal(report.ok,true);
 const protocol=JSON.parse(await readFile(path.join(outputDirectory,"protocol.json"),"utf8"));assert.equal(protocol.driverIdentity.environment,undefined,"missing historical context snapshots remain unknown");
});
