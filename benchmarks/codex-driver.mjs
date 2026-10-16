import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { redact } from "../.ai-harness/src/evidence.mjs";
import { saveJson } from "./runner.mjs";
import { codexMemoryArguments } from "./codex-environment.mjs";
import { createToolTiming, toolCategory } from "./timing.mjs";
import { completedRun, inspectFinal, parseFinal, redactProtocolValue, responseSchema } from "./protocol.mjs";

export function codexProtocol(events) {
  events = events.map(redactProtocolValue);
  const errors = [], warnings = [];
  for (const event of events) if (["error", "turn.failed"].includes(event.type)) {
    const warning = event.type === "error" && (event.severity || event.error?.severity || event.level) === "warning";
    (warning ? warnings : errors).push(JSON.stringify(event));
  }
  const turn = events.findLast(event => event.type === "turn.completed");
  return { turnCompleted: Boolean(turn), protocolSuccess: Boolean(turn) && errors.length === 0, usage: turn?.usage ?? null, errors, warnings };
}

const containerDisabledFeatures=["apps","plugins","browser_use","browser_use_external","computer_use","image_generation","remote_plugin","in_app_browser","enable_mcp_apps","codex_apps_mcp_2026_07_28","mcp_2026_07_28","standalone_web_search","tool_call_mcp_elicitation","skill_mcp_dependency_install"];
export function codexArguments({root,outputDirectory,model,budget,container=false}) {
  const finalFile=container?path.posix.join(outputDirectory,"final.json"):path.join(outputDirectory,"final.json");
  const schema=container?path.posix.join(outputDirectory,"response.schema.json"):path.join(outputDirectory,"response.schema.json");
  const boundary=container?["--dangerously-bypass-approvals-and-sandbox",...containerDisabledFeatures.flatMap(feature=>["--disable",feature]),"-c",'web_search="disabled"',"-c","mcp_servers={}"]:["--sandbox","workspace-write"];
  return ["exec",...codexMemoryArguments,"--ephemeral","--json","--color","never",...boundary,"-C",root,"-m",model,
    "-c",`model_reasoning_effort="${budget.reasoning}"`,"--output-schema",schema,"-o",finalFile,"-"];
}

export function codexDriver(cli,{runtime=null}={}) {
  return async ({ root, model, prompt, budget, outputDirectory }) => {
    const finalFile = path.join(outputDirectory, "final.json");
    const schema = path.join(outputDirectory, "response.schema.json");
    await saveJson(schema, responseSchema);
    const runtimePaths=runtime?runtime.paths({root,outputDirectory}):{root,outputDirectory};
    const args=codexArguments({...runtimePaths,model,budget,container:Boolean(runtime)});
    const script=/\.(m?js)$/i.test(cli),hostCommand=script?process.execPath:cli;
    const launch=runtime?await runtime.prepare({root,outputDirectory,args}):{command:hostCommand,args:script?[cli,...args]:args,cwd:root,detached:process.platform!=="win32",stop:null,cleanup:null};
    const startedAt = new Date().toISOString();
    const result = await new Promise(resolve => {
      const started = Date.now();
      const child = spawn(launch.command, launch.args, { cwd: launch.cwd, shell: false, windowsHide: true, detached: launch.detached, stdio: ["pipe","pipe","pipe"] });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      let stderr = "", pending = "", timedOut = false, toolLimit = false, spawnError = null, unparsedLines = 0;
      const runtimeErrors=[];
      const runtimeFailure=value=>{if(value&&!runtimeErrors.includes(value))runtimeErrors.push(value);};
      const protocolLines = [];
      const events = [], toolIds = new Set();
      const timing = createToolTiming({messages:true});
      function stop() {
        if (!child.pid) return;
        runtimeFailure(launch.stop?.() ?? null);
        if (process.platform === "win32") {
          if (child.exitCode !== null) return;
          spawnSync("taskkill", ["/PID",String(child.pid),"/T","/F"], { windowsHide: true, stdio: "ignore" });
        } else {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
      const timer = setTimeout(() => { timedOut = true; stop(); }, budget.timeoutMs);
      function line(raw, at = Date.now()-started) {
        if (!raw.trim()) return;
        let event; try { event = JSON.parse(raw); } catch { unparsedLines++; protocolLines.push("! malformed JSONL"); return; }
        if (!event || Array.isArray(event) || typeof event.type !== "string") { unparsedLines++; protocolLines.push("! invalid event structure"); return; }
        event = redactProtocolValue(event);
        protocolLines.push(JSON.stringify(event));
        events.push(event);
        timing.protocol(at, event.type === "turn.completed");
        if (event.type === "item.completed" && event.item?.type === "agent_message") timing.message(at, Boolean(parseFinal(event.item.text)));
        if (event.item && ["command_execution","file_change","mcp_tool_call","web_search"].includes(event.item.type)) {
          toolIds.add(event.item.id);
          if (event.type === "item.started") timing.start(event.item.id, at, toolCategory(event.item.type, event.item.command));
          if (event.type === "item.completed") timing.end(event.item.id, at);
          if (toolIds.size >= budget.maxToolCalls) { toolLimit = true; stop(); }
        }
      }
      child.stdout.on("data", chunk => { pending += chunk; const lines=pending.split(/\r?\n/);pending=lines.pop();for(const value of lines)line(value); });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdin.on("error", error => { spawnError ||= error.message; });
      child.once("error", error => { spawnError=error.message; });
      child.once("exit", () => timing.exited(Date.now()-started));
      child.once("close", exitCode => {
        const closedAt = Date.now()-started;
        timing.closed(closedAt);
        clearTimeout(timer); if(pending.trim())line(pending, closedAt);
        runtimeFailure(launch.cleanup?.() ?? null);
        const durationMs = Date.now()-started;
        const failures=[spawnError,...runtimeErrors].filter(Boolean);
        resolve({ mode: "real", client: "codex", startedAt, durationMs, timing: timing.summarize(durationMs), exitCode, timedOut, toolLimit, toolCalls:toolIds.size,
          ...codexProtocol(events), unparsedLines, error: failures.length ? redact(failures.join("; ")) : null,
          stdout: protocolLines.join("\n") + (protocolLines.length ? "\n" : ""), stderr: redact(stderr) });
      });
      child.stdin.end(prompt);
    });
    await writeFile(path.join(outputDirectory,"events.jsonl"),result.stdout);
    await writeFile(path.join(outputDirectory,"stderr.txt"),result.stderr);
    let final=null,finalOutput;
    try {
      const bytes=await readFile(finalFile),observed=inspectFinal(bytes.toString("utf8"));
      final=observed.final;
      finalOutput={version:1,status:observed.status,exists:true,bytes:bytes.length,errorCode:null};
    } catch (error) {
      const code=typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : null;
      finalOutput={version:1,status:code === "ENOENT" ? "missing" : "unreadable",exists:code === "ENOENT" ? false : null,bytes:null,errorCode:code};
    }
    await writeFile(finalFile, JSON.stringify(final, null, 2) + "\n");
    return {...result,stdout:undefined,stderr:undefined,final,finalOutput,
      completed:completedRun(result, final)};
  };
}
