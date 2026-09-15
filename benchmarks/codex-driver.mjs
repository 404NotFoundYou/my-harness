import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { redact } from "../.ai-harness/src/evidence.mjs";
import { saveJson } from "./runner.mjs";
import { createToolTiming } from "./timing.mjs";

export function codexDriver(cli) {
  return async ({ root, model, prompt, budget, outputDirectory }) => {
    const finalFile = path.join(outputDirectory, "final.json");
    const schema = path.join(outputDirectory, "response.schema.json");
    await saveJson(schema, { type: "object", properties: { completed: {type:"boolean"}, summary: {type:"string"}, tests: {type:"array",items:{type:"string"}} }, required: ["completed","summary","tests"], additionalProperties: false });
    const args = ["exec", "--ephemeral", "--json", "--color", "never", "--sandbox", "workspace-write", "-C", root, "-m", model,
      "-c", `model_reasoning_effort="${budget.reasoning}"`, "--output-schema", schema, "-o", finalFile, "-"];
    const command = /\.(m?js)$/i.test(cli) ? process.execPath : cli;
    const launchArgs = command === process.execPath ? [cli, ...args] : args;
    const startedAt = new Date().toISOString();
    const result = await new Promise(resolve => {
      const started = Date.now();
      const child = spawn(command, launchArgs, { cwd: root, shell: false, windowsHide: true, stdio: ["pipe","pipe","pipe"] });
      let stdout = "", stderr = "", pending = "", timedOut = false, toolLimit = false, spawnError = null;
      const events = [], toolIds = new Set();
      const timing = createToolTiming();
      function stop() {
        if (child.exitCode !== null || !child.pid) return;
        if (process.platform === "win32") spawnSync("taskkill", ["/PID",String(child.pid),"/T","/F"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
      }
      const timer = setTimeout(() => { timedOut = true; stop(); }, budget.timeoutMs);
      function line(raw) {
        let event; try { event = JSON.parse(raw); } catch { return; }
        events.push(event);
        if (event.item && ["command_execution","file_change","mcp_tool_call","web_search"].includes(event.item.type)) {
          toolIds.add(event.item.id);
          if (event.type === "item.started") timing.start(event.item.id, Date.now()-started);
          if (event.type === "item.completed") timing.end(event.item.id, Date.now()-started);
          if (toolIds.size >= budget.maxToolCalls) { toolLimit = true; stop(); }
        }
      }
      child.stdout.on("data", chunk => { stdout += chunk; pending += chunk; const lines=pending.split(/\r?\n/);pending=lines.pop();for(const value of lines)line(value); });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdin.on("error", error => { spawnError ||= error.message; });
      child.once("error", error => { spawnError=error.message; });
      child.once("close", exitCode => {
        clearTimeout(timer); if(pending.trim())line(pending);
        const turn = events.findLast(event => event.type === "turn.completed");
        const durationMs = Date.now()-started;
        resolve({ mode: "real", client: "codex", startedAt, durationMs, timing: timing.summarize(durationMs), exitCode, timedOut, toolLimit, toolCalls:toolIds.size,
          turnCompleted: Boolean(turn), usage: turn?.usage ?? null, error: spawnError ? redact(spawnError) : null,
          errors: events.filter(event=>["error","turn.failed"].includes(event.type)).map(event=>redact(JSON.stringify(event))),
          stdout: redact(stdout), stderr: redact(stderr) });
      });
      child.stdin.end(prompt);
    });
    await writeFile(path.join(outputDirectory,"events.jsonl"),result.stdout);
    await writeFile(path.join(outputDirectory,"stderr.txt"),result.stderr);
    let final=null;try{final=JSON.parse(await readFile(finalFile,"utf8"));}catch{}
    return {...result,stdout:undefined,stderr:undefined,final,
      completed:result.exitCode===0&&!result.timedOut&&!result.toolLimit&&!result.error&&result.turnCompleted&&final?.completed===true};
  };
}
