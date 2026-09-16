import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { installRuntime } from "../../src/installer.mjs";
import { sourceRoot, git } from "../../tests/helpers.mjs";

const baseline="2df067e216f20db04e4c57c7d65977c707fac1de";
test("compare old and new Git readers in ABBA order with equal surrounding payload",async()=>{
  const parent=await mkdtemp(path.join(tmpdir(),"ai-harness-profile-compare-"));
  const script=".ai-harness/work-items/HARNESS-PERF-20260916/profile.test.mjs";
  const implementations={};
  try{
    for(const variant of ["old","new"]){
      const root=path.join(parent,variant);await mkdir(root);
      await installRuntime(sourceRoot,root);
      await cp(path.join(sourceRoot,"benchmarks"),path.join(root,"benchmarks"),{recursive:true});
      await mkdir(path.dirname(path.join(root,script)),{recursive:true});
      await writeFile(path.join(root,script),await readFile(path.join(sourceRoot,script)));
      if(variant === "old")for(const file of [".ai-harness/src/git.mjs",".ai-harness/src/snapshot.mjs"]){
        const original=spawnSync("git",["show",`${baseline}:${file}`],{cwd:sourceRoot,shell:false,windowsHide:true});
        assert.equal(original.status,0);await writeFile(path.join(root,file),original.stdout);
      }
      git(root,["init"]);git(root,["config","user.email","profile@example.invalid"]);git(root,["config","user.name","Harness Profile"]);
      git(root,["add","."]);git(root,["commit","-m","fixed profile source"]);
      implementations[variant]=root;
    }
    const runs=[];
    for(const [index,variant]of ["old","new","new","old"].entries()){
      const result=spawnSync(process.execPath,["--test",script],{cwd:implementations[variant],shell:false,windowsHide:true,encoding:"utf8",timeout:70000,maxBuffer:1024*1024,env:{...process.env,NODE_TEST_CONTEXT:undefined}});
      assert.equal(result.status,0,result.stderr||result.stdout);
      const line=result.stdout.split("\n").find(line=>line.startsWith("# PROFILE "));
      assert.ok(line,"measurement must produce its full sample record");
      runs.push({order:index+1,variant,profile:JSON.parse(line.slice(10))});
    }
    assert.equal(new Set(runs.map(run=>run.profile.payloadFiles)).size,1);
    console.log("COMPARISON "+JSON.stringify({baseline,order:["old","new","new","old"],runs,limitations:"Each version uses the same current surrounding payload and the original profiler. Only git.mjs/snapshot.mjs differ; local measurements are not a fixed CI speedup guarantee."}));
  }finally{
    const resolved=await realpath(parent);assert.equal(path.dirname(resolved),await realpath(tmpdir()));assert.ok(path.basename(resolved).startsWith("ai-harness-profile-compare-"));await rm(resolved,{recursive:true,force:true});
  }
});
