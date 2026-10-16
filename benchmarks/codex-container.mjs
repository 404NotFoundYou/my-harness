import assert from "node:assert/strict";
import path from "node:path";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";

export const containerRuntimeVersion=1;
const sha256=/^[a-f0-9]{64}$/;
const imageDigest=/^[^@\s]+@sha256:[a-f0-9]{64}$/;
const identityUser="65534:65534";
const workspaceTarget="/workspace",outputTarget="/output";
const wrapperIntegrity="sha512-47dfpl2e8F47baSQTE+QaWzF/kKoOeR9YQ2fIBdRGzZZP2/QZ6D0uwLY2ZamS8ypov4UFtg92jZh8m+w65bsGg==";
const platformIntegrity="sha512-/PX399ISB715skgBBOtOX5aqLxmPQhYC7wDasZnAJhRrtzt3qgs6kjSnimN9T8OFKv4LDAp+uJdN896tQYaTrA==";
const pidsLimit=128,memoryLimit=1536*1024*1024,nanoCpus=2_000_000_000,tmpfsOptions=["rw","exec","nosuid","nodev","size=268435456","mode=1777"];

const digest=value=>createHash("sha256").update(value).digest("hex");
export function runtimeUser({uid=typeof process.getuid==="function"?process.getuid():null,gid=typeof process.getgid==="function"?process.getgid():null}={}){
 if(uid===null||gid===null)return identityUser;
 assert.ok(Number.isSafeInteger(uid)&&Number.isSafeInteger(gid)&&uid>0&&gid>0,"Docker runtime requires non-root POSIX UID and GID");
 return `${uid}:${gid}`;
}
function exactKeys(value,keys,label){assert.ok(value&&typeof value==="object"&&!Array.isArray(value),`Invalid ${label}`);assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),`Invalid ${label} fields`);}
function containerPath(value,label){assert.equal(typeof value,"string",`Invalid ${label}`);assert.ok(path.posix.isAbsolute(value),`${label} must be an absolute POSIX path`);assert.equal(path.posix.normalize(value),value,`${label} must be normalized`);assert.ok(!value.includes("\\")&&!/[\r\n]/.test(value),`Invalid ${label}`);return value;}
function runDocker(docker,args,{timeout=20000}={}){const result=childProcess.spawnSync(docker,args,{encoding:"utf8",shell:false,windowsHide:true,timeout,maxBuffer:16*1024*1024});return{status:result.status,signal:result.signal,errorCode:result.error?.code??null,stdout:result.stdout??"",stderr:result.stderr??""};}
function dockerOutput(result,label){assert.equal(result.errorCode,null,`${label} could not start`);assert.equal(result.signal,null,`${label} was terminated`);assert.equal(result.status,0,`${label} failed with exit ${result.status}`);return result.stdout.trim();}
function sameHostPath(left,right){const a=path.resolve(left),b=path.resolve(right);return process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;}
function safeHostPath(value,label){assert.ok(typeof value==="string"&&!/[\r\n,]/.test(value),`${label} cannot contain commas or line breaks`);return value;}
function nested(left,right){const relative=path.relative(left,right);return relative===""||(!relative.startsWith(".."+path.sep)&&relative!=="..");}

export function validateContainerManifest(value){
 exactKeys(value,["schemaVersion","image","imageId","platform","nodeEntry","nodeVersion","cliEntry","cliVersion","cliSha256","nativeEntry","nativeSha256","wrapperIntegrity","platformIntegrity"],"container manifest");
 assert.equal(value.schemaVersion,1,"Unsupported container manifest version");assert.match(value.image,imageDigest,"Container image must be pinned by digest");
 assert.match(value.imageId,/^sha256:[a-f0-9]{64}$/,"Invalid container image ID");assert.equal(value.platform,"linux/amd64","Only linux/amd64 container runtimes are supported");
 containerPath(value.nodeEntry,"nodeEntry");containerPath(value.cliEntry,"cliEntry");containerPath(value.nativeEntry,"nativeEntry");
 assert.equal(value.nodeVersion,"v22.20.0","Unsupported container Node version");assert.equal(value.cliVersion,"0.156.0","Unsupported container Codex version");
 assert.match(value.cliSha256,sha256,"Invalid CLI SHA-256");assert.match(value.nativeSha256,sha256,"Invalid native SHA-256");
 assert.equal(value.wrapperIntegrity,wrapperIntegrity,"Unsupported Codex wrapper integrity");assert.equal(value.platformIntegrity,platformIntegrity,"Unsupported Codex platform integrity");
 return structuredClone(value);
}

export function validateContainerIdentity(value){
 exactKeys(value,["kind","manifest","manifestSha256","runtimeVersion","image","imageId","platform","nodeVersion","cliVersion","cliSha256","nativeSha256","wrapperIntegrity","platformIntegrity"],"container identity");
 assert.equal(value.kind,"container");assert.ok(path.isAbsolute(value.manifest),"Container manifest path must be absolute");assert.match(value.manifestSha256,sha256);
 assert.equal(value.runtimeVersion,containerRuntimeVersion);assert.match(value.image,imageDigest);assert.match(value.imageId,/^sha256:[a-f0-9]{64}$/);assert.equal(value.platform,"linux/amd64");
 assert.equal(value.nodeVersion,"v22.20.0");assert.equal(value.cliVersion,"0.156.0");assert.match(value.cliSha256,sha256);assert.match(value.nativeSha256,sha256);assert.equal(value.wrapperIntegrity,wrapperIntegrity);assert.equal(value.platformIntegrity,platformIntegrity);
 return structuredClone(value);
}

export async function readContainerManifest(file){const manifest=await realpath(file),bytes=await readFile(manifest),value=validateContainerManifest(JSON.parse(bytes.toString("utf8")));return{manifest,manifestSha256:digest(bytes),value};}

function inspectSecurity(value,inspection,{mounts,openStdin,user=identityUser}){
 assert.equal(inspection.Image,value.imageId,"Created container image differs");assert.equal(inspection.Config?.User,user,"Created container user differs");assert.equal(inspection.Config?.OpenStdin,openStdin,"Created container stdin mode differs");
 assert.equal(inspection.HostConfig?.NetworkMode,"none","Created container network must be disabled");assert.equal(inspection.HostConfig?.ReadonlyRootfs,true,"Created container root must be read-only");
 assert.equal(inspection.HostConfig?.Privileged,false,"Created container cannot be privileged");
 assert.deepEqual(inspection.HostConfig?.CapDrop,["ALL"],"Created container capabilities differ");assert.ok(inspection.HostConfig?.SecurityOpt?.includes("no-new-privileges:true"),"Created container must prevent privilege escalation");
 const actualTmpfs=String(inspection.HostConfig?.Tmpfs?.["/tmp"]??"").split(",").filter(Boolean).sort();assert.deepEqual(actualTmpfs,[...tmpfsOptions].sort(),"Created container tmpfs differs");
 assert.equal(inspection.HostConfig?.PidsLimit,pidsLimit,"Created container PID limit differs");assert.equal(inspection.HostConfig?.Memory,memoryLimit,"Created container memory limit differs");assert.equal(inspection.HostConfig?.NanoCpus,nanoCpus,"Created container CPU limit differs");assert.deepEqual(inspection.HostConfig?.RestartPolicy,{Name:"no",MaximumRetryCount:0},"Created container restart policy differs");assert.deepEqual(inspection.HostConfig?.PortBindings??{}, {},"Created container cannot publish ports");
 const actual=(inspection.Mounts??[]).map(row=>({type:row.Type,destination:row.Destination,readWrite:row.RW,source:row.Source}));assert.equal(actual.some(row=>row.type==="volume"),false,"Created container cannot attach volumes");assert.ok(actual.every(row=>row.type==="bind"),"Created container can only use bind mounts");assert.equal(actual.length,mounts,"Created container mount count differs");return actual;
}

function inspectContainer(value,inspection,root,outputDirectory,user){const mounts=inspectSecurity(value,inspection,{mounts:2,openStdin:true,user});const workspace=mounts.find(row=>row.destination===workspaceTarget),output=mounts.find(row=>row.destination===outputTarget);assert.ok(workspace&&output,"Created container mount destinations differ");assert.equal(workspace.readWrite,true,"Workspace mount must be writable");assert.equal(output.readWrite,true,"Output mount must be writable");assert.ok(sameHostPath(workspace.source,root),"Workspace mount source differs");assert.ok(sameHostPath(output.source,outputDirectory),"Output mount source differs");}

function cleanupContainer(docker,name,force=true){const args=["rm",...(force?["--force"]:[]),"--volumes",name],result=runDocker(docker,args);return (result.status===0&&result.errorCode===null&&result.signal===null)||/No such container/i.test(result.stderr)?null:`Docker container cleanup failed (${result.status??result.errorCode??"unknown"})`;}

const identityScript='const fs=require("node:fs"),c=require("node:crypto"),p=require("node:child_process");const h=f=>c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"),r=p.spawnSync(process.execPath,[process.argv[1],"--version"],{encoding:"utf8",shell:false,timeout:20000});if(r.status!==0)process.exit(71);const m=/^codex-cli ([^\\s]+)\\s*$/.exec(r.stdout);if(!m)process.exit(72);console.log(JSON.stringify({nodeVersion:process.version,cliVersion:m[1],cliSha256:h(process.argv[1]),nativeSha256:h(process.argv[2])}));';

async function declaredContainerIdentity(file,{docker="docker",expected=null}={}){
 const record=await readContainerManifest(file),value=record.value,inspection=JSON.parse(dockerOutput(runDocker(docker,["image","inspect",value.image]),"Docker image inspection"));
 assert.ok(Array.isArray(inspection)&&inspection.length===1,"Invalid Docker image inspection");const image=inspection[0];assert.equal(image.Id,value.imageId,"Container image identity changed");assert.equal(image.Os,"linux","Container image OS changed");assert.equal(image.Architecture,"amd64","Container image architecture changed");
 const declared=validateContainerIdentity({kind:"container",manifest:record.manifest,manifestSha256:record.manifestSha256,runtimeVersion:containerRuntimeVersion,image:value.image,imageId:value.imageId,platform:value.platform,nodeVersion:value.nodeVersion,cliVersion:value.cliVersion,cliSha256:value.cliSha256,nativeSha256:value.nativeSha256,wrapperIntegrity:value.wrapperIntegrity,platformIntegrity:value.platformIntegrity});
 if(expected!==null)assert.deepEqual(declared,validateContainerIdentity(expected),"Container identity changed during recheck");
 return {record,declared};
}

export async function verifyContainerIdentity(file,options={}){
 return (await declaredContainerIdentity(file,options)).declared;
}

export async function containerIdentity(file,{docker="docker",expected=null}={}){
 const {record,declared}=await declaredContainerIdentity(file,{docker,expected}),value=record.value;
 const name=`ai-harness-identity-${randomUUID()}`,createArgs=["create","--name",name,"--interactive","--pull","never","--network","none","--read-only","--user",identityUser,"--cap-drop","ALL","--security-opt","no-new-privileges:true","--pids-limit",String(pidsLimit),"--memory","1536m","--cpus","2","--restart","no","--env","HOME=/tmp/home","--env","CODEX_HOME=/tmp/codex-home","--env","PATH=/usr/local/bin:/usr/bin:/bin","--tmpfs","/tmp:"+tmpfsOptions.join(","),"--entrypoint",value.nodeEntry,value.image,"-e",identityScript,value.cliEntry,value.nativeEntry];
 let primary=null,observed=null;try{dockerOutput(runDocker(docker,createArgs,{timeout:30000}),"Docker identity container creation");const rows=JSON.parse(dockerOutput(runDocker(docker,["inspect",name]),"Docker identity container inspection"));assert.ok(Array.isArray(rows)&&rows.length===1,"Invalid Docker identity container inspection");inspectSecurity(value,rows[0],{mounts:0,openStdin:true,user:identityUser});observed=JSON.parse(dockerOutput(runDocker(docker,["start","--attach",name],{timeout:30000}),"Docker identity measurement"));}catch(error){primary=error;}
 const cleanup=cleanupContainer(docker,name,true);if(primary&&cleanup)throw new AggregateError([primary,new Error(cleanup)],"Container identity measurement and cleanup failed");if(primary)throw primary;if(cleanup)throw new Error(cleanup);
 exactKeys(observed,["nodeVersion","cliVersion","cliSha256","nativeSha256"],"container measurement");assert.equal(observed.nodeVersion,value.nodeVersion,"Container Node version differs");assert.equal(observed.cliVersion,value.cliVersion,"Container CLI version differs");assert.equal(observed.cliSha256,value.cliSha256,"Container CLI hash differs");assert.equal(observed.nativeSha256,value.nativeSha256,"Container native hash differs");
 return declared;
}

function createContainerRuntime({manifest,expectedIdentity,docker}){
 return{
  paths(){return{root:workspaceTarget,outputDirectory:outputTarget};},
  async prepare({root,outputDirectory,args}){
   const current=await verifyContainerIdentity(manifest,{docker,expected:expectedIdentity});const record=await readContainerManifest(manifest);assert.equal(record.manifestSha256,current.manifestSha256,"Container manifest changed before launch");const value=record.value,user=runtimeUser();
   root=await realpath(root);outputDirectory=await realpath(outputDirectory);assert.ok((await lstat(root)).isDirectory(),"Workspace must be a directory");assert.ok((await lstat(outputDirectory)).isDirectory(),"Output must be a directory");
   assert.ok(!nested(root,outputDirectory)&&!nested(outputDirectory,root),"Workspace and output mounts cannot overlap");safeHostPath(root,"Workspace path");safeHostPath(outputDirectory,"Output path");
   const name=`ai-harness-codex-${randomUUID()}`,createArgs=["create","--name",name,"--interactive","--pull","never","--network","none","--read-only","--user",user,"--cap-drop","ALL","--security-opt","no-new-privileges:true","--pids-limit",String(pidsLimit),"--memory","1536m","--cpus","2","--restart","no","--env","HOME=/tmp/home","--env","CODEX_HOME=/tmp/codex-home","--env","PATH=/usr/local/bin:/usr/bin:/bin","--tmpfs","/tmp:"+tmpfsOptions.join(","),"--mount",`type=bind,src=${root},dst=${workspaceTarget}`,"--mount",`type=bind,src=${outputDirectory},dst=${outputTarget}`,"--entrypoint",value.nodeEntry,value.image,value.cliEntry,...args];
   try{
    dockerOutput(runDocker(docker,createArgs,{timeout:30000}),"Docker container creation");
    const rows=JSON.parse(dockerOutput(runDocker(docker,["inspect",name]),"Docker container inspection"));assert.ok(Array.isArray(rows)&&rows.length===1,"Invalid Docker container inspection");inspectContainer(value,rows[0],root,outputDirectory,user);
   }catch(error){const cleanup=cleanupContainer(docker,name,true);if(cleanup)throw new AggregateError([error,new Error(cleanup)],"Container preparation and cleanup failed");throw error;}
   return{command:docker,args:["start","--attach","--interactive",name],cwd:root,detached:process.platform!=="win32",
    stop(){const result=runDocker(docker,["kill",name]);return result.status===0||/is not running|No such container/i.test(result.stderr)?null:`Docker container stop failed (${result.status??result.errorCode??"unknown"})`;},
    cleanup(){return cleanupContainer(docker,name);}};
  },
 };
}

export async function loadContainerRuntime(file,{docker="docker",expectedIdentity=null}={}){const record=await readContainerManifest(file),identity=expectedIdentity===null?await containerIdentity(record.manifest,{docker}):await verifyContainerIdentity(record.manifest,{docker,expected:expectedIdentity});assert.equal(record.manifestSha256,identity.manifestSha256,"Container manifest changed while loading");return{cli:record.value.cliEntry,identity,readIdentity:()=>verifyContainerIdentity(record.manifest,{docker,expected:identity}),runtime:createContainerRuntime({manifest:identity.manifest,expectedIdentity:identity,docker})};}
