import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rename, realpath, rm, writeFile } from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { getGitBaseline, changedFilesSince } from "../src/git.mjs";
import { sourceSnapshot } from "../src/snapshot.mjs";
import { git } from "./helpers.mjs";

async function fixture({commit=true}={}){
  const root=await mkdtemp(path.join(tmpdir(),"ai-harness-git-state-"));
  await mkdir(path.join(root,".ai-harness"));
  await writeFile(path.join(root,".ai-harness/config.json"),JSON.stringify({workItemsDirectory:".ai-harness/work-items"}));
  await writeFile(path.join(root,".gitattributes"),"*.txt text eol=lf\n");
  for(const file of ["tracked.txt","deleted.txt","rename name.txt","removed-index.txt"])await writeFile(path.join(root,file),`${file}\n`);
  git(root,["init"]);git(root,["config","user.email","git-state@example.invalid"]);git(root,["config","user.name","Git State Test"]);
  if(commit){git(root,["add","."]);git(root,["commit","-m","fixture baseline"]);}
  return root;
}
async function cleanup(root){const resolved=await realpath(root);assert.equal(path.dirname(resolved),await realpath(tmpdir()));assert.ok(path.basename(resolved).startsWith("ai-harness-git-state-"));await rm(resolved,{recursive:true,force:true});}
const paths=result=>result.stdout.split("\0").filter(Boolean).map(file=>file.replaceAll("\\","/"));
function legacyPaths(root){return [...new Set([
  ...paths(git(root,["diff","--name-only","-z","--no-renames","--ignore-submodules=none"])),
  ...paths(git(root,["diff","--cached","--name-only","-z","--no-renames"])),
  ...paths(git(root,["ls-files","--others","--exclude-standard","-z"])),
])].sort();}
const oid=(root,file)=>git(root,["hash-object",file]).stdout.trim();

test("baseline identities preserve staged, unstaged, deleted and literal untracked paths",async()=>{
  const root=await fixture();
  try{
    const baseline=git(root,["rev-parse","HEAD"]).stdout.trim();
    await writeFile(path.join(root,"tracked.txt"),"staged\n");git(root,["add","tracked.txt"]);
    await writeFile(path.join(root,"tracked.txt"),"newer working tree\r\n");
    await rm(path.join(root,"deleted.txt"));
    await rename(path.join(root,"rename name.txt"),path.join(root,"重命名 file.txt"));
    git(root,["add","--all"]);
    await writeFile(path.join(root,"tracked.txt"),"unstaged after stage\r\n");
    git(root,["rm","--cached","removed-index.txt"]);
    const names=[" leading space.txt","目录/中文 file.txt",...(process.platform === "win32"?[]:["trailing space ","line\nbreak.txt"])];
    for(const file of names){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),"literal\n");}
    git(root,["config","status.renames","true"]);
    git(root,["config","status.showUntrackedFiles","no"]);
    const state=await getGitBaseline(root);
    assert.deepEqual(state.changedFiles,legacyPaths(root));
    assert.ok(state.changedFiles.includes("rename name.txt"));
    assert.ok(state.changedFiles.includes("重命名 file.txt"));
    assert.ok(state.changedFiles.includes("removed-index.txt"));
    assert.equal(state.fingerprints["deleted.txt"],null);
    assert.equal(state.fingerprints["tracked.txt"],createHash("sha256").update(await readFile(path.join(root,"tracked.txt"))).digest("hex"));
    assert.deepEqual((await changedFilesSince(root,baseline)).files,state.changedFiles);
    const snapshot=await sourceSnapshot(root);
    assert.equal(snapshot.files["tracked.txt"],`100644:${oid(root,"tracked.txt")}`);
    assert.equal(snapshot.files["removed-index.txt"],`100644:${oid(root,"removed-index.txt")}`);
    assert.equal(snapshot.files["rename name.txt"],undefined);
    assert.equal(snapshot.files["deleted.txt"],undefined);
    const before=snapshot.digest;
    git(root,["add","--all"]);
    assert.equal((await sourceSnapshot(root)).digest,before,"staging the same bytes must not invalidate their snapshot");
  }finally{await cleanup(root);}
});

test("index-only entries, intent-to-add and staged-then-deleted files keep their source meaning",async()=>{
  const root=await fixture();
  try{
    await writeFile(path.join(root,"staged.txt"),"staged only\n");git(root,["add","staged.txt"]);
    await writeFile(path.join(root,"intent.txt"),"intent content\n");git(root,["add","-N","intent.txt"]);
    await writeFile(path.join(root,"gone.txt"),"added then removed\n");git(root,["add","gone.txt"]);await rm(path.join(root,"gone.txt"));
    const snapshot=await sourceSnapshot(root);
    assert.equal(snapshot.files["staged.txt"],`100644:${oid(root,"staged.txt")}`);
    assert.equal(snapshot.files["intent.txt"],`100644:${oid(root,"intent.txt")}`);
    assert.equal(snapshot.files["gone.txt"],undefined);
    assert.deepEqual((await getGitBaseline(root)).changedFiles,legacyPaths(root));
    await writeFile(path.join(root,"intent.txt"),"later edit\n");
    assert.notEqual((await sourceSnapshot(root)).digest,snapshot.digest,"later edits must not reuse an earlier state collection");
  }finally{await cleanup(root);}
});

test("detached, unborn and linked worktrees retain branch and commit facts",async()=>{
  const unborn=await fixture({commit:false});
  const root=await fixture();
  const container=await mkdtemp(path.join(tmpdir(),"ai-harness-git-state-"));
  try{
    const first=await getGitBaseline(unborn);
    assert.equal(first.commit,null);
    assert.equal(first.branch,git(unborn,["symbolic-ref","--short","HEAD"]).stdout.trim());
    assert.deepEqual(first.changedFiles,legacyPaths(unborn));
    const head=git(root,["rev-parse","HEAD"]).stdout.trim();
    const linked=path.join(container,"linked");git(root,["worktree","add","--detach",linked,"HEAD"]);
    const state=await getGitBaseline(linked);
    assert.equal(state.isGit,true);assert.equal(state.branch,null);assert.equal(state.commit,head);assert.equal(state.dirty,false);
    assert.equal((await sourceSnapshot(linked)).digest,(await sourceSnapshot(root)).digest);
  }finally{await cleanup(container);await cleanup(root);await cleanup(unborn);}
});

test("conflicted index entries still prevent a trustworthy source snapshot",async()=>{
  const root=await fixture();
  try{
    const first=git(root,["rev-parse","HEAD"]).stdout.trim();
    await writeFile(path.join(root,"tracked.txt"),"one\n");git(root,["add","tracked.txt"]);git(root,["commit","-m","first side"]);
    const side=git(root,["rev-parse","HEAD"]).stdout.trim();
    git(root,["checkout","--detach",first]);
    await writeFile(path.join(root,"tracked.txt"),"two\n");git(root,["add","tracked.txt"]);git(root,["commit","-m","second side"]);
    assert.notEqual(git(root,["merge",side],{allowFailure:true}).status,0);
    assert.deepEqual((await getGitBaseline(root)).changedFiles,legacyPaths(root));
    await assert.rejects(()=>sourceSnapshot(root),{code:"UNMERGED_SOURCE"});
  }finally{await cleanup(root);}
});

test("Git file-mode policy and clean filters still determine snapshot identity",async()=>{
  const root=await fixture();
  try{
    git(root,["config","core.filemode","false"]);
    git(root,["update-index","--chmod=+x","tracked.txt"]);
    await writeFile(path.join(root,"tracked.txt"),"changed with CRLF\r\n");
    const snapshot=await sourceSnapshot(root);
    assert.equal(snapshot.files["tracked.txt"],`100755:${oid(root,"tracked.txt")}`);
    git(root,["add","tracked.txt"]);
    assert.equal((await sourceSnapshot(root)).digest,snapshot.digest);
    if(process.platform !== "win32"){
      git(root,["config","core.filemode","true"]);
      await chmod(path.join(root,"tracked.txt"),0o644);
      assert.equal((await sourceSnapshot(root)).files["tracked.txt"],`100644:${oid(root,"tracked.txt")}`);
      await chmod(path.join(root,"tracked.txt"),0o755);
      assert.equal((await sourceSnapshot(root)).files["tracked.txt"],`100755:${oid(root,"tracked.txt")}`);
    }
  }finally{await cleanup(root);}
});

test("staged gitlinks remain valid but working-tree submodule changes are rejected",async()=>{
  const root=await fixture(),module=await fixture();
  try{
    git(root,["-c","protocol.file.allow=always","submodule","add",module,"child"]);
    git(root,["commit","-am","add local module"]);
    const child=path.join(root,"child"),file=path.join(child,"tracked.txt"),original=await readFile(file);
    await writeFile(file,"dirty\n");
    await assert.rejects(()=>sourceSnapshot(root),{code:"DIRTY_SUBMODULE"});
    await writeFile(file,original);
    await writeFile(path.join(child,"untracked.txt"),"new\n");
    await assert.rejects(()=>sourceSnapshot(root),{code:"DIRTY_SUBMODULE"});
    await rm(path.join(child,"untracked.txt"));
    await writeFile(file,"committed child\n");git(child,["add","tracked.txt"]);
    git(child,["-c","user.name=Git State Test","-c","user.email=git-state@example.invalid","commit","-m","advance child"]);
    await assert.rejects(()=>sourceSnapshot(root),{code:"DIRTY_SUBMODULE"});
    git(root,["add","child"]);
    assert.equal((await sourceSnapshot(root)).files.child,`160000:${git(child,["rev-parse","HEAD"]).stdout.trim()}`);
  }finally{await cleanup(root);await cleanup(module);}
});

test("metadata and snapshots use bounded Git queries without reusing stale observations",async(t)=>{
  const root=await fixture(),spawn=childProcess.spawnSync;let calls=0;
  try{
    t.mock.method(childProcess,"spawnSync",(...args)=>{if(args[0]==="git")calls++;return spawn(...args);});syncBuiltinESMExports();
    assert.equal((await getGitBaseline(root)).dirty,false);
    assert.ok(calls<=3,`baseline used ${calls} Git processes`);
    calls=0;await sourceSnapshot(root);assert.ok(calls<=3,`clean snapshot used ${calls} Git processes`);
    await writeFile(path.join(root,"tracked.txt"),"changed now\n");
    calls=0;const changed=await sourceSnapshot(root);assert.ok(calls<=4,`dirty snapshot used ${calls} Git processes`);
    t.mock.restoreAll();syncBuiltinESMExports();
    assert.equal(changed.files["tracked.txt"],`100644:${oid(root,"tracked.txt")}`);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await cleanup(root);}
});
