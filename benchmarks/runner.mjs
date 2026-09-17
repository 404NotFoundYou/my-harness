import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { installRuntime, initializeProject } from "../.ai-harness/src/installer.mjs";
import { checkProject } from "../.ai-harness/src/checker.mjs";
import { loadPlan, loadWorkItem } from "../.ai-harness/src/workflow.mjs";
import { redact } from "../.ai-harness/src/evidence.mjs";
import { atomicWriteJson } from "../.ai-harness/src/filesystem.mjs";
import { sourceSnapshot } from "../.ai-harness/src/snapshot.mjs";
import { trialStatistics } from "./statistics.mjs";
import { projectWorkflowContract, taskManifest, writableFilesFor } from "./task-contract.mjs";
import { candidateDigest, collectCandidate, validateCandidate } from "./candidates.mjs";

export const budget = Object.freeze({ timeoutMs: 180000, maxToolCalls: 80, reasoning: "medium" });
export const hash = value => createHash("sha256").update(value).digest("hex");
export const groups = (weak, strong) => [
  { id: "weak-baseline", model: weak, harness: false },
  { id: "weak-harness", model: weak, harness: true },
  { id: "strong-reference", model: strong, harness: false },
];
const beginSpecPath = ".ai-harness/work-items/benchmark-begin-spec.json";
const ownedDirectories = new Set();

async function temporary(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  ownedDirectories.add(await realpath(root));
  return root;
}

export async function cleanupSandbox(root) {
  const resolved = await realpath(root);
  if (!ownedDirectories.has(resolved) || path.dirname(resolved) !== await realpath(tmpdir())) throw new Error("Refusing cleanup outside a created temporary directory");
  // Git can still be retiring a pack directory during sandbox cleanup.
  for(let attempt=0;attempt<3;attempt++){
    try{
      await rm(resolved,{recursive:true,force:true});
      ownedDirectories.delete(resolved);
      return;
    }catch(error){
      if(error.code!=="ENOTEMPTY"||attempt===2)throw error;
      await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
    }
  }
}

export async function saveJson(file, value) {
  await atomicWriteJson(file,value);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git failed: ${redact(result.stderr)}`);
  return result.stdout.trim();
}

async function filesAt(root, prefix = "") {
  const files = Object.create(null);
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (!prefix && entry.name === ".git") continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(root, relative);
    if (entry.isSymbolicLink()) files[relative] = `link:${await readlink(absolute)}`;
    else if (entry.isDirectory()) Object.assign(files, await filesAt(root, relative));
    else files[relative] = hash(await readFile(absolute));
  }
  return files;
}

export async function createParticipant(task, { sourceRoot, harness }) {
  if (task.writableFiles !== undefined) taskManifest(task);
  const root = await temporary("ai-harness-bench-");
  try {
    for (const [relative, content] of Object.entries(task.files)) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    }
    const instructions = task.type === "BUGFIX"
      ? "使用简体中文。完成TASK.md中的已授权BUGFIX，先复现再修复并回归，保留实际/期望、根因和失败证据。必要可逆实现自主推进。范围以TASK.md为准；不安装依赖、不使用网络、不提交Git、不修改登录配置。未完成必须如实说明。\n"
      : "使用简体中文。完成TASK.md中的已授权普通迭代，必要可逆实现自主推进。范围以TASK.md为准；不安装依赖、不使用网络、不提交Git、不修改登录配置。公共验证通过后核对规格，未完成必须如实说明。\n";
    const guidance = harness && task.writableFiles === undefined
      ? `先在项目相对路径${beginSpecPath}只填写risk和approach；保留预填的writeScopes、verification及docsImpact的N/A理由。用项目相对路径运行node .ai-harness/bin/harness.mjs begin --spec ${beginSpecPath} --json，再用guide查看缺失事项。\n`
      : "";
    await writeFile(path.join(root, "AGENTS.md"), instructions + guidance);
    git(root, ["init"]);
    git(root, ["config", "user.name", "Harness Benchmark"]);
    git(root, ["config", "user.email", "benchmark@example.invalid"]);
    git(root, ["config", "core.autocrlf", "false"]);
    if (harness) {
      await installRuntime(sourceRoot, root);
      await initializeProject(root, { mode: "existing", docsMode: "existing" });
    }
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixed benchmark baseline"]);
    return { root, baseline: await filesAt(root), head: git(root, ["rev-parse", "HEAD"]) };
  } catch (error) { await cleanupSandbox(root); throw error; }
}

export async function inspectChanges(participant, task, harness) {
  const current = await filesAt(participant.root);
  const changes = [...new Set([...Object.keys(participant.baseline), ...Object.keys(current)])]
    .filter(file => participant.baseline[file] !== current[file])
    .map(file => ({ path: file, before: participant.baseline[file] ?? null, after: current[file] ?? null }));
  const writable = writableFilesFor(task);
  const violations = changes.filter(change => !writable.includes(change.path) && change.path !== "test/extra.test.mjs" &&
    !(harness && change.path.startsWith(".ai-harness/work-items/"))).map(change => change.path);
  if (git(participant.root, ["rev-parse", "HEAD"]) !== participant.head) violations.push("Git HEAD changed");
  return { ok: violations.length === 0, changes, violations };
}

export function parseGrade(output, marker, expectedIds, exitCode) {
  const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker));
  let result;
  try { if (lines.length === 1) result = JSON.parse(lines[0].slice(marker.length)); } catch {}
  const complete = Array.isArray(result?.cases) && JSON.stringify(result.cases.map(row => row.id)) === JSON.stringify(expectedIds) &&
    result.cases.every(row => typeof row.pass === "boolean");
  return { complete, ok: exitCode === 0 && complete && result.cases.every(row => row.pass), cases: complete ? result.cases : [], expectedCases: expectedIds.length };
}

export async function gradeCandidate(task, implementation) {
  if (task.writableFiles !== undefined) {
    taskManifest(task);
    implementation=validateCandidate(task,implementation);
    if (Object.values(implementation.files).some(entry=>entry.status!=="present")) return {complete:false,ok:false,cases:[],expectedCases:task.cases.length,exitCode:null,timedOut:false,stderr:"",error:"Incomplete or invalid candidate files"};
  }
  const root = await temporary("ai-harness-grade-");
  const marker = `BENCHMARK_${randomUUID()}:`;
  try {
    if (task.writableFiles === undefined) {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, task.entry), implementation);
    } else {
      // Build from frozen read-only files; writable baseline implementations never enter this tree.
      for (const [file,content] of Object.entries(task.files)) {
        if (Object.hasOwn(implementation.files,file)) continue;
        await mkdir(path.dirname(path.join(root,file)),{recursive:true});
        await writeFile(path.join(root,file),content);
      }
      for (const [file,entry] of Object.entries(implementation.files)) {
        await mkdir(path.dirname(path.join(root,file)),{recursive:true});
        await writeFile(path.join(root,file),entry.content);
      }
    }
    const code = `import assert from "node:assert/strict";\nimport { ${task.name} as f } from "./${task.entry}";\n` +
      `const tests=[${task.cases.map(([id, body]) => `{id:${JSON.stringify(id)},run:${task.writableFiles === undefined ? "" : "async "}()=>{${body}}}`).join(",")}];\n` +
      `const cases=[];for(const t of tests){try{await t.run();cases.push({id:t.id,pass:true});}catch(e){cases.push({id:t.id,pass:false,error:String(e.stack||e)});}}\n` +
      `console.log(${JSON.stringify(marker)}+JSON.stringify({cases}));process.exitCode=cases.every(t=>t.pass)?0:1;\n`;
    await writeFile(path.join(root, "judge.mjs"), code);
    const run = spawnSync(process.execPath, ["--experimental-permission", `--allow-fs-read=${root}`, path.join(root, "judge.mjs")], {
      cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "", NODE_TEST_CONTEXT: undefined },
    });
    return { ...parseGrade(run.stdout || "", marker, task.cases.map(([id]) => id), run.status), exitCode: run.status,
      timedOut: run.error?.code === "ETIMEDOUT", stderr: redact(run.stderr || ""), error: run.error ? redact(run.error.message) : null };
  } finally { await cleanupSandbox(root); }
}

export function participantPrompt(task, group, runBudget = budget) {
  if (task.writableFiles !== undefined) {
    return `请完成TASK.md中的BUGFIX，先读规格、${Object.keys(task.files).filter(file=>file.startsWith("src/")).join("、")}和公共测试，实际复现再修复与回归。\n` +
      `只有${writableFilesFor(task).join("、")}和新增test/extra.test.mjs可写（Harness组另可通过CLI维护工作项控制面）。不得修改原测试、规格、调用方或固定依赖，不安装依赖、不访问网络、不提交Git。无需询问已授权实现选择。\n` +
      `预算${runBudget.timeoutMs/1000}秒、${runBudget.maxToolCalls}次工具调用；到期如实报告未完成。最终按结构化格式报告completed、summary和实际运行的tests。\n` +
      (group.harness ? "本组已安装并初始化Harness，按AGENTS使用BUGFIX路径，记录实际/期望、复现和根因，保留static/sandbox/reproduction/regression阶段；复现与回归引用真实run命令。guide可查看缺失证据，finish提交真实审查与验收，最终check --ci。\n" : "按项目规范保留复现、修复和回归证据。\n");
  }
  return `请在当前临时项目完成TASK.md中的迭代，先读规格、实现、src/caller.mjs和公共测试，然后实现并验证。\n` +
    `只有${task.entry}和新增test/extra.test.mjs可写（Harness组另可通过CLI维护工作项控制面）。不要修改原有测试或规格，不安装依赖、不访问网络、不提交Git。无需询问已授权的实现选择。\n` +
    `预算${runBudget.timeoutMs / 1000}秒、${runBudget.maxToolCalls}次工具调用；到期如实报告未完成。最终按结构化格式报告completed、summary和实际运行的tests。\n` +
    (group.harness ? `本组已安装并初始化Harness。${beginSpecPath}已预填公开写入范围和公共验证命令；请根据实际方案填写risk(low/medium)与approach，再运行node .ai-harness/bin/harness.mjs begin --spec ${beginSpecPath} --json。创建后用guide --id ${task.id}-iteration --task T1 --json查看缺失事项，用run --all执行计划检查；实际finish和check --ci均通过后立即返回结构化最终结果，未完成如实报告。\n` : "按当前项目规范直接实施与验证。\n");
}

export async function runCase({ task, group, sourceRoot, outputDirectory, driver, runBudget = budget, trial = 1, execution = null, beforePublish = null }) {
  await mkdir(outputDirectory);
  const participant = await createParticipant(task, { sourceRoot, harness: group.harness });
  try {
    if(group.harness&&task.writableFiles===undefined){
      const spec={schemaVersion:1,id:`${task.id}-iteration`,type:"ITERATION",title:`完成${task.id}固定迭代`,references:["TASK.md"],
        acceptance:["保持TASK.md的公开契约并通过test/public.test.mjs"],authorizationSource:"TASK.md中的已授权固定任务",
        risk:"",approach:"",databaseEvidence:"TASK.md明确无数据库影响",writeScopes:[task.entry,"test/extra.test.mjs"],
        verification:[{command:"node",args:["--test","test/public.test.mjs"]}],docsImpact:["N/A: 固定公开规格与文档不变"]};
      await writeFile(path.join(participant.root,beginSpecPath),JSON.stringify(spec,null,2)+"\n",{flag:"wx"});
    }
    const prompt = participantPrompt(task, group, runBudget);
    await writeFile(path.join(outputDirectory, "prompt.txt"), prompt);
    const run = await driver({ root: participant.root, model: group.model, prompt, budget: {...runBudget}, outputDirectory });
    const scope = await inspectChanges(participant, task, group.harness);
    let implementation;
    if (task.writableFiles === undefined) {
      const sourceFile = path.join(participant.root, task.entry);
      const info = await lstat(sourceFile).catch(() => null);
      implementation = info?.isFile() && !info.isSymbolicLink() ? await readFile(sourceFile, "utf8") : "";
      await writeFile(path.join(outputDirectory, "candidate.mjs"), implementation);
    } else {
      implementation=await collectCandidate(participant.root,task);
      await saveJson(path.join(outputDirectory,"candidate-files.json"),implementation);
      const invalid=Object.entries(implementation.files).filter(([,entry])=>entry.status!=="present").map(([file])=>file);
      scope.violations=[...new Set([...scope.violations,...invalid])];
      scope.ok=scope.violations.length===0;
    }
    const extraPath = path.join(participant.root, "test/extra.test.mjs");
    const extraInfo = await lstat(extraPath).catch(() => null);
    if (extraInfo?.isFile() && !extraInfo.isSymbolicLink()) await writeFile(path.join(outputDirectory, "extra.test.mjs"), await readFile(extraPath));
    let workflow = null;
    if (group.harness) {
      try {
        const checked = await checkProject(participant.root, { ci: true });
        workflow = { ok: checked.ok && checked.details.workItems.length > 0, errors: checked.errors, workItems: checked.details.workItems };
        if (task.writableFiles !== undefined && checked.ok) {
          const records=[];
          for (const id of checked.details.workItems) records.push({state:await loadWorkItem(participant.root,id),plan:await loadPlan(participant.root,id,{optional:true})});
          workflow.contract=projectWorkflowContract(task,records);
          if (!workflow.contract.ok) {
            workflow.ok=false;
            workflow.errors.push(`Project workflow requires ${task.type} development items covering all writable files`);
          }
        }
        for (const id of checked.details.workItems) {
          for (const file of ["state.json", "plan.json", "evidence.jsonl", "events.jsonl"]) {
            const content = await readFile(path.join(participant.root, ".ai-harness/work-items", id, file), "utf8").catch(() => null);
            if (content !== null) { await mkdir(path.join(outputDirectory, "work-items", id), { recursive: true }); await writeFile(path.join(outputDirectory, "work-items", id, file), redact(content)); }
          }
        }
      } catch (error) { workflow = { ok: false, errors: [redact(error.message)] }; }
    }
    const grade = await gradeCandidate(task, implementation);
    const success = Boolean(run.completed && scope.ok && grade.ok && (!group.harness || workflow?.ok));
    const result = { schemaVersion: task.writableFiles === undefined ? 1 : 2, trial, mode: run.mode, client: run.client || "codex", taskId: task.id, split: task.split, group: group.id, model: group.model,
      taskDigest: hash(JSON.stringify(task.files)), judgeDigest: hash(JSON.stringify(task.cases)), candidateDigest: task.writableFiles === undefined ? hash(implementation) : candidateDigest(task,implementation), budget: runBudget,
      run, scope, workflow, grade, success, falseCompletion: Boolean(run.final?.completed && !success),
      falseFunctionalCompletion: Boolean(run.final?.completed && !grade.ok) };
    if(execution)result.execution={...execution,sourceAfter:(await sourceSnapshot(sourceRoot)).digest};
    if(beforePublish)await beforePublish();
    await saveJson(path.join(outputDirectory, "result.json"), result);
    return result;
  } finally { await cleanupSandbox(participant.root); }
}

export function summarize(results, { extended = false } = {}) {
  const modes = new Set(results.map(result => result.mode));
  if (new Set(results.map(result => result.client || "codex")).size !== 1) throw new Error("Different clients must be reported separately");
  if (modes.size !== 1 || !["real", "simulated"].includes([...modes][0])) throw new Error("Real and simulated results must not be mixed");
  return [...new Set(results.map(result => result.group))].map(group => {
    const rows = results.filter(result => result.group === group);
    return { group, samples: rows.length, functionalPassed: rows.filter(row => row.grade.ok).length, completed: rows.filter(row => row.success).length,
      falseCompletion: rows.filter(row => row.falseCompletion).length, timeouts: rows.filter(row => row.run.timedOut).length,
      durationMs: rows.reduce((sum, row) => sum + (row.run.durationMs || 0), 0),
      inputTokens: rows.every(row => row.run.usage) ? rows.reduce((sum,row)=>sum+row.run.usage.input_tokens,0) : null,
      outputTokens: rows.every(row => row.run.usage) ? rows.reduce((sum,row)=>sum+row.run.usage.output_tokens,0) : null,
      ...(extended ? { statistics: trialStatistics(rows) } : {}) };
  });
}
