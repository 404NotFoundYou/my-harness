import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { tasks } from "../tasks.mjs";
import { budget, cleanupSandbox, createParticipant, gradeCandidate, groups, inspectChanges, parseGrade, participantPrompt, runCase, summarize } from "../runner.mjs";
import { createToolTiming, toolCategory } from "../timing.mjs";
import { clientArguments, clientDriver, createClientEventReader, readProtocolTranscript } from "../client-drivers.mjs";
import { experimentPlan, runExperiment } from "../experiment.mjs";
import { auditExperiment } from "../audit.mjs";
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");

test("timing merges overlapping tools and labels remaining time without calling it inference",()=>{
  const timing=createToolTiming();
  timing.start("a",0);timing.start("b",5);timing.end("a",10);timing.end("b",15);timing.end("unseen",16);
  const result=timing.summarize(20);
  assert.equal(result.toolActiveMs,15);
  assert.equal(result.otherElapsedMs,5);
  assert.deepEqual(result.unmatchedCompletions,["unseen"]);
});

test("synthetic Claude and Gemini streams require terminal success and preserve tool timing",()=>{
  const final={completed:true,summary:"fixture only",tests:["fixture"]};
  for(const client of ["claude","gemini"]){
    const timing=createToolTiming(),reader=createClientEventReader(client,timing);
    if(client==="claude"){
      reader.accept({type:"stream_event",event:{type:"content_block_start",content_block:{type:"tool_use",id:"t1"}}},2);
      reader.accept({type:"assistant",message:{content:[{type:"tool_use",id:"t1"}]}},3);
      reader.accept({type:"user",message:{content:[{type:"tool_result",tool_use_id:"t1"}]}},7);
      assert.equal(reader.finish().protocolSuccess,false);
      reader.accept({type:"result",subtype:"success",is_error:false,structured_output:final,usage:{input_tokens:10,cache_read_input_tokens:5,output_tokens:2}},10);
      assert.equal(reader.finish().usage.input_tokens,15);
    }else{
      reader.accept({type:"message",role:"assistant",content:"progress",delta:true},1);
      reader.accept({type:"tool_use",tool_id:"t1"},2);
      reader.accept({type:"tool_result",tool_id:"t1"},7);
      reader.accept({type:"message",role:"assistant",content:JSON.stringify(final),delta:true},8);
      assert.equal(reader.finish().protocolSuccess,false);
      reader.accept({type:"result",status:"success",stats:{unknownFormat:true}},10);
      assert.equal(reader.finish().usage,null);
    }
    assert.equal(reader.toolCalls,1);
    assert.equal(reader.finish().protocolSuccess,true);
    assert.deepEqual(reader.finish().final,final);
    assert.equal(timing.summarize(10).toolActiveMs,5);
  }
  const claude=clientArguments("claude","test-model",budget);
  assert.equal(claude.includes("--dangerously-skip-permissions"),false);
  assert.equal(claude[claude.indexOf("--allowedTools")+1].includes("harness.mjs install"),false);
  assert.equal(clientArguments("gemini","test-model",budget).includes("--sandbox"),true);
});

test("synthetic fatal errors cannot be hidden by a later success, while explicit warnings remain visible",()=>{
  for(const client of ["claude","gemini"]){
    const final={completed:true,summary:"synthetic fixture",tests:[]};
    const terminal=client==="claude"?{type:"result",subtype:"success",is_error:false,structured_output:final,usage:{}}:{type:"result",status:"success",response:JSON.stringify(final)};
    const failure=createClientEventReader(client,createToolTiming());
    failure.accept({type:"error",message:"fatal"},1);failure.accept(terminal,2);
    assert.equal(failure.finish().protocolSuccess,false);
    assert.equal(failure.finish().errors.length,1);
    assert.equal(failure.finish().usage,null);
    const warning=createClientEventReader(client,createToolTiming());
    warning.accept({type:"error",severity:"warning",message:"non-fatal"},1);warning.accept(terminal,2);
    assert.equal(warning.finish().protocolSuccess,true);
    assert.equal(warning.finish().warnings.length,1);
  }
});

test("a synthetic CLI process with corrupt JSONL cannot claim complete despite exit zero",async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),"ai-harness-driver-fixture-"));
  try{
    const shim=path.join(directory,"synthetic-cli.mjs");
    const terminal={type:"result",subtype:"success",is_error:false,structured_output:{completed:true,summary:"synthetic fixture only",tests:[]}};
    await writeFile(shim,`console.log("broken-json-line"); console.log(${JSON.stringify(JSON.stringify(terminal))});\n`);
    const result=await clientDriver("claude",shim)({root:directory,model:"synthetic-fixture",prompt:"No model service is used in this test.",budget:{timeoutMs:5000,maxToolCalls:5},outputDirectory:directory});
    assert.equal(result.exitCode,0);
    assert.equal(result.unparsedLines,1);
    assert.equal(result.completed,false);
  }finally{
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-driver-fixture-"));
    await rm(directory,{recursive:true,force:true});
  }
});

test("hidden judges accept all reference contracts and reject incomplete implementations",async()=>{
  for(const task of tasks){
    const reference=await gradeCandidate(task,task.reference);
    assert.equal(reference.ok,true,JSON.stringify(reference));
    assert.equal(reference.cases.length,task.cases.length);
    assert.equal((await gradeCandidate(task,task.files[task.entry])).ok,false);
  }
});

test("exit zero, missing or duplicate tests cannot impersonate a completed acceptance run",async()=>{
  assert.equal((await gradeCandidate(tasks[0],`process.exit(0);export function parseCsv(){return [];}`)).ok,false);
  assert.equal(parseGrade('MARK{"cases":[{"id":"one","pass":true}]}',"MARK",["one","two"],0).ok,false);
  assert.equal(parseGrade('MARK{"cases":[{"id":"one","pass":true},{"id":"one","pass":true}]}',"MARK",["one","two"],0).ok,false);
});

test("all groups share contracts and budgets, while hidden cases and references stay outside participant files",async()=>{
  assert.equal(budget.timeoutMs,180000);
  const matrix=groups("weak","strong");
  assert.equal(matrix[0].model,matrix[1].model);
  for(const group of matrix){
    const participant=await createParticipant(tasks[0],{sourceRoot,harness:group.harness});
    try{
      for(const [file,content]of Object.entries(tasks[0].files))assert.equal(await readFile(path.join(participant.root,file),"utf8"),content);
      assert.equal((await readdir(participant.root)).includes("benchmarks"),false);
      assert.match(participantPrompt(tasks[0],group),/180秒、80次/);
      assert.equal((await inspectChanges(participant,tasks[0],group.harness)).ok,true);
      await writeFile(path.join(participant.root,"TASK.md"),"weakened task");
      assert.deepEqual((await inspectChanges(participant,tasks[0],group.harness)).violations,["TASK.md"]);
    }finally{await cleanupSandbox(participant.root);}
  }
});

test("a simulated driver exercises grading and false completion without becoming a real model result",async()=>{
  const output=await mkdtemp(path.join(tmpdir(),"ai-harness-bench-test-"));
  try{
    const row=await runCase({task:tasks[0],group:groups("weak","strong")[0],sourceRoot,outputDirectory:output,
      driver:async()=>({mode:"simulated",completed:true,final:{completed:true},durationMs:1,usage:null})});
    assert.equal(row.falseFunctionalCompletion,true);
    assert.equal(row.success,false);
    assert.equal(summarize([row])[0].completed,0);
    assert.throws(()=>summarize([row,{...row,mode:"real"}]));
  }finally{
    const resolved=path.resolve(output);
    assert.equal(path.dirname(resolved),path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("ai-harness-bench-test-"));
    await rm(resolved,{recursive:true,force:true});
  }
});

test("every client rejects broken or failed protocols instead of trusting a later completion", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-protocol-test-"));
  try {
    for (const client of ["codex", "claude", "gemini"]) {
      for (const scenario of ["normal", "warning", "redacted-final", "quoted-final", "broken", "null", "fatal", "failed-result", "invalid-final", "missing-terminal", "exit-failure"]) {
        const output = path.join(directory, `${client}-${scenario}`);
        await mkdir(output);
        const final = scenario === "invalid-final" ? { completed: true } : { completed: true,
          summary: scenario === "redacted-final" ? "fixture API_TOKEN=synthetic_value" : scenario === "quoted-final" ? "fixture API_TOKEN='synthetic value'" : "synthetic only", tests: [] };
        const terminal = client === "codex" ? { type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }
          : client === "claude" ? { type: "result", subtype: "success", structured_output: final } : { type: "result", status: "success", response: JSON.stringify(final) };
        const failed = client === "codex" ? { type: "turn.failed" } : client === "claude" ? { type: "result", subtype: "error" } : { type: "result", status: "error" };
        const prefix = scenario === "broken" ? ["broken-json"] : scenario === "null" ? ["null"]
          : scenario === "fatal" ? [JSON.stringify({ type: "error", message: "synthetic failure" })]
          : scenario === "warning" ? [JSON.stringify({ type: "error", severity: "warning", message: "synthetic warning" })]
          : scenario === "failed-result" ? [JSON.stringify(failed)] : [];
        const lines = [...prefix, ...(scenario === "missing-terminal" ? [] : [JSON.stringify(terminal)])];
        const shim = path.join(output, "synthetic.mjs");
        await writeFile(shim, `import { writeFile } from "node:fs/promises"; process.stdin.resume();\n${client === "codex" ? `await writeFile(process.argv[process.argv.indexOf("-o")+1], ${JSON.stringify(JSON.stringify(final))});\n` : ""}for (const line of ${JSON.stringify(lines)}) console.log(line); process.exitCode=${scenario === "exit-failure" ? 1 : 0};\n`);
        const result = await clientDriver(client, shim)({ root: directory, model: "synthetic", prompt: "No model calls", budget: { timeoutMs: 5000, maxToolCalls: 5 }, outputDirectory: output });
        assert.equal(result.completed, ["normal", "warning", "redacted-final", "quoted-final"].includes(scenario), `${client}: ${scenario}`);
        if (["redacted-final", "quoted-final"].includes(scenario)) {
          const transcript = await readFile(path.join(output, "events.jsonl"), "utf8");
          const storedFinal = await readFile(path.join(output, "final.json"), "utf8");
          assert.equal(transcript.includes("synthetic_value"), false);
          assert.equal(storedFinal.includes("synthetic_value"), false);
          assert.equal(transcript.includes("synthetic value"), false);
          const reconstructed = readProtocolTranscript(client, transcript, storedFinal);
          assert.equal(reconstructed.unparsedLines, 0);
          assert.deepEqual(reconstructed.final, result.final);
        }
        if (["broken", "null"].includes(scenario)) assert.equal(result.unparsedLines, 1);
        if (scenario === "warning") assert.equal(result.warnings.length, 1);
        if (["fatal", "failed-result"].includes(scenario)) assert.ok(result.errors.length > 0);
      }
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-protocol-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeated paired trials preserve independent outputs and remain explicitly simulated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-experiment-test-"));
  try {
    const plan = experimentPlan({ weak: "synthetic", comparison: "paired", repetitions: 2, timeoutMs: 4000 });
    assert.equal(plan.schedule.length, 12);
    assert.equal(new Set(plan.schedule.map(entry => entry.directory)).size, 12);
    assert.equal(experimentPlan({ weak: "w", strong: "s" }).schedule.length, 9);
    assert.throws(() => experimentPlan({ weak: "w", comparison: "paired", repetitions: 0 }));
    const outputDirectory = path.join(directory, "run");
    let calls = 0;
    const result = await runExperiment({ plan, sourceRoot, outputDirectory, mode: "simulated", driver: async ({ root, outputDirectory }) => {
      calls++;
      const specification = await readFile(path.join(root, "TASK.md"), "utf8");
      const task = tasks.find(task => task.files["TASK.md"] === specification);
      await writeFile(path.join(root, task.entry), task.reference);
      await writeFile(path.join(outputDirectory, "events.jsonl"), '{"type":"synthetic"}\n');
      return { mode: "simulated", client: "codex", completed: true, final: { completed: true, summary: "synthetic", tests: [] }, durationMs: calls, usage: null };
    } });
    assert.equal(calls, 12);
    assert.equal(result.complete, true);
    assert.deepEqual(result.notRun, []);
    assert.ok(result.groups.every(group => group.samples === 6 && group.statistics.sharedDelivery.passed === 6 && group.inputTokens === null));
    assert.equal(result.groups.find(group => group.group === "weak-harness").statistics.fullDelivery.passed, 0);
    const audited = await auditExperiment(outputDirectory);
    assert.equal(audited.mode, "simulated");
    assert.equal(audited.samples, 12);
    // 只在此临时单元夹具中构造 real 协议形状，验证审计不信任自报字段；没有模型调用。
    const protocol = JSON.parse(await readFile(path.join(outputDirectory, "protocol.json"), "utf8"));
    protocol.mode = "real";
    await writeFile(path.join(outputDirectory, "protocol.json"), JSON.stringify(protocol));
    const summary = JSON.parse(await readFile(path.join(outputDirectory, "summary.json"), "utf8"));
    summary.mode = "real";
    await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(summary));
    for (const entry of plan.schedule) {
      const folder = path.join(outputDirectory, entry.directory);
      const row = JSON.parse(await readFile(path.join(folder, "result.json"), "utf8"));
      row.mode = "real";
      Object.assign(row.run, { mode: "real", exitCode: 0, error: null, errors: [], warnings: [], unparsedLines: 0, turnCompleted: true, protocolSuccess: true });
      await writeFile(path.join(folder, "result.json"), JSON.stringify(row));
      await writeFile(path.join(folder, "final.json"), JSON.stringify(row.run.final));
      await writeFile(path.join(folder, "events.jsonl"), '{"type":"turn.completed"}\n');
    }
    assert.equal((await auditExperiment(outputDirectory)).valid, true);
    const firstLog = path.join(outputDirectory, plan.schedule[0].directory, "events.jsonl");
    await writeFile(firstLog, "");
    await assert.rejects(() => auditExperiment(outputDirectory), /raw protocol/);
    await writeFile(firstLog, '{"type":"turn.completed"}\n');
    summary.results[0].success = !summary.results[0].success;
    await writeFile(path.join(outputDirectory, "summary.json"), JSON.stringify(summary));
    await assert.rejects(() => auditExperiment(outputDirectory));
    const broken = path.join(directory, "interrupted");
    await assert.rejects(() => runExperiment({ plan, sourceRoot, outputDirectory: broken, mode: "simulated", driver: async () => { throw new Error("fixture unavailable"); } }));
    const incomplete = JSON.parse(await readFile(path.join(broken, "summary.json"), "utf8"));
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.notRun.length, 12);
    await assert.rejects(() => auditExperiment(broken));
    await assert.rejects(() => runExperiment({ plan, sourceRoot, outputDirectory, driver: async () => assert.fail("must not overwrite") }), { code: "EEXIST" });
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-experiment-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("dry-run reveals the frozen call budget without invoking a client or writing an experiment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-experiment-test-"));
  try {
    const output = path.join(directory, "unused");
    const result = spawnSync(process.execPath, [path.join(sourceRoot, "benchmarks/run.mjs"), "--cli", "not-installed", "--weak", "fixture", "--comparison", "paired", "--repetitions", "5", "--out", output, "--dry-run"], { shell: false, windowsHide: true, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).modelCalls, 30);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("historical nine-sample protocols retain their original statistics and evidence", async () => {
  for (const round of ["pilot", "followup"]) {
    const result = await auditExperiment(path.join(sourceRoot, ".ai-harness/work-items/MODEL-BENCHMARK-001", round));
    assert.equal(result.samples, 9);
    assert.equal(result.mode, "real");
    assert.equal(result.groups.find(group => group.group === "weak-baseline").completed, 3);
    assert.equal(result.groups.find(group => group.group === "weak-harness").completed, 1);
  }
});

test("installed evidence retains exact bytes through Git add and fresh CRLF checkouts", async () => {
  const participant = await createParticipant(tasks[0], { sourceRoot, harness: true });
  const directory = await mkdtemp(path.join(tmpdir(), "ai-harness-checkout-test-"));
  const git = (root, args) => {
    const result = spawnSync("git", args, { cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    git(participant.root, ["config", "core.autocrlf", "true"]);
    const files = {
      ".ai-harness/work-items/CHECKOUT-PROOF/candidate.mjs": Buffer.from("export const value = 1;\n"),
      ".ai-harness/work-items/CHECKOUT-PROOF/artifacts/lf.txt": Buffer.from("line one\nline two\n"),
      ".ai-harness/work-items/CHECKOUT-PROOF/artifacts/crlf.txt": Buffer.from("line one\r\nline two\r\n"),
      ".ai-harness/work-items/CHECKOUT-PROOF/artifacts/binary.bin": Buffer.from([0, 10, 13, 255]),
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(participant.root, file)), { recursive: true });
      await writeFile(path.join(participant.root, file), content);
    }
    git(participant.root, ["add", "--", ".ai-harness/work-items/CHECKOUT-PROOF"]);
    git(participant.root, ["commit", "-m", "freeze evidence bytes"]);
    for (const autocrlf of ["true", "false"]) {
      const checkout = path.join(directory, autocrlf);
      git(directory, ["clone", "--quiet", "--no-hardlinks", "--config", `core.autocrlf=${autocrlf}`, participant.root, checkout]);
      for (const [file, expected] of Object.entries(files)) assert.deepEqual(await readFile(path.join(checkout, file)), expected,
        `${file}: evidence must survive checkout without changing the bytes used by its hash`);
    }
  } finally {
    await cleanupSandbox(participant.root);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("ai-harness-checkout-test-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("timing categories merge overlapping intervals and statistics retain unknown measurements", () => {
  const timing = createToolTiming();
  timing.start("one", 0, toolCategory("command_execution", "node .ai-harness/bin/harness.mjs run --id X"));
  timing.start("two", 5, "verification"); timing.end("one", 10); timing.end("two", 15);
  assert.deepEqual(timing.summarize(20).categories.verification, { calls: 2, activeMs: 15 });
  const base = { mode: "simulated", group: "weak-baseline", grade: { ok: true }, scope: { ok: true }, success: true, run: { completed: true, durationMs: 10, usage: null } };
  const rows = [base, { ...base, success: false, run: { completed: false, timedOut: true, durationMs: 30, usage: null } }, { ...base, run: { completed: true, durationMs: undefined, usage: null } }];
  const statistics = summarize(rows, { extended: true })[0].statistics;
  assert.deepEqual(statistics.latency, { observed: 2, unknown: 1, medianMs: 20, p95Ms: 29 });
  assert.equal(statistics.fullDelivery.rate, 2 / 3);
  assert.ok(statistics.fullDelivery.interval95[0] < 2 / 3 && statistics.fullDelivery.interval95[1] > 2 / 3);
  assert.equal(statistics.usageSamples, 0);
  const invalid = summarize([{ ...base, run: { completed: false, final: null, protocolSuccess: true, errors: [], usage: null } }], { extended: true })[0].statistics;
  assert.equal(invalid.protocolFailures, 1);
  assert.equal(invalid.invalidFinals, 1);
});

test("raw protocol reconstruction retains terminal failures and malformed content blocks", () => {
  for (const client of ["claude", "gemini"]) {
    const final = { completed: true, summary: "synthetic", tests: [] };
    const success = client === "claude" ? { type: "result", subtype: "success", structured_output: final } : { type: "result", status: "success", response: JSON.stringify(final) };
    const failure = client === "claude" ? { type: "result", subtype: "error" } : { type: "result", status: "error" };
    assert.equal(readProtocolTranscript(client, "").protocolSuccess, false);
    assert.equal(readProtocolTranscript(client, [failure, success].map(event => JSON.stringify(event)).join("\n")).protocolSuccess, false);
    assert.equal(readProtocolTranscript(client, JSON.stringify(success)).protocolSuccess, true);
    if (client === "claude") assert.equal(readProtocolTranscript(client, [ { type: "assistant", message: { content: [null] } }, success ].map(event => JSON.stringify(event)).join("\n")).protocolSuccess, false);
  }
});
