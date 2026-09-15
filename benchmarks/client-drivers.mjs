import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { redact } from "../.ai-harness/src/evidence.mjs";
import { codexDriver } from "./codex-driver.mjs";
import { createToolTiming } from "./timing.mjs";

const responseSchema = { type: "object", properties: { completed: { type: "boolean" }, summary: { type: "string" }, tests: { type: "array", items: { type: "string" } } }, required: ["completed", "summary", "tests"], additionalProperties: false };

function parseFinal(text) {
  try {
    const value = typeof text === "string" ? JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")) : text;
    return value && typeof value.completed === "boolean" && typeof value.summary === "string" && Array.isArray(value.tests) && value.tests.every(entry=>typeof entry === "string") ? value : null;
  } catch { return null; }
}

export function clientArguments(client, model, budget) {
  if (client === "claude") {
    const commands = ["policies", "begin", "guide", "show", "run", "finish", "record", "task-update", "check", "reopen", "replan", "task-edit", "plan-approve"];
    const allowed = ["Read", "Glob", "Grep", "Edit", "Write", "Bash(node --test *)", "Bash(node --check *)", "Bash(git status *)", "Bash(git diff *)", ...commands.map(command => `Bash(node .ai-harness/bin/harness.mjs ${command} *)`)];
    return ["-p", "--model", model, "--effort", budget.reasoning || "medium", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence", "--permission-mode", "dontAsk", "--tools", "Read,Glob,Grep,Edit,Write,Bash", "--allowedTools", allowed.join(","), "--json-schema", JSON.stringify(responseSchema)];
  }
  if (client === "gemini") return ["--prompt", "完成标准输入中的任务，最终只输出包含completed、summary、tests的JSON对象。", "--model", model, "--output-format", "stream-json", "--sandbox", "--approval-mode", "auto_edit"];
  throw new Error(`Unsupported client: ${client}`);
}

export function createClientEventReader(client, timing) {
  let answer = "", result = null;
  const tools = new Set();
  const errors = [];
  const warnings = [];
  return {
    accept(event, at) {
      if (client === "claude") {
        const block = event.type === "stream_event" && event.event?.type === "content_block_start" ? event.event.content_block : null;
        const content = event.message?.content || [];
        for (const part of [...(block ? [block] : []), ...(Array.isArray(content) ? content : [])]) {
          if (part.type === "tool_use" && typeof part.id === "string") { tools.add(part.id); timing.start(part.id, at); }
          if (part.type === "tool_result") timing.end(part.tool_use_id, at);
        }
        if (event.type === "result") result = event;
      } else {
        if (event.type === "tool_use") { if (typeof event.tool_id === "string") tools.add(event.tool_id); timing.start(event.tool_id, at); answer = ""; }
        if (event.type === "tool_result") timing.end(event.tool_id, at);
        if (event.type === "message" && event.role === "assistant" && typeof event.content === "string") answer = event.delta ? answer + event.content : event.content;
        if (event.type === "result") result = event;
      }
      if (event.type === "error") {
        const severity = event.severity || event.error?.severity || event.level;
        (severity === "warning" ? warnings : errors).push(redact(JSON.stringify(event)));
      }
    },
    get toolCalls() { return tools.size; },
    finish() {
      const final = client === "claude" ? parseFinal(result?.structured_output ?? result?.result) : parseFinal(result?.response ?? answer);
      const successful = client === "claude" ? result?.subtype === "success" && !result.is_error : result?.status === "success";
      const rawUsage = client === "claude" ? result?.usage : result?.stats;
      const countsValid = rawUsage && ["input_tokens", "output_tokens"].every(key => Number.isSafeInteger(rawUsage[key]) && rawUsage[key] >= 0) &&
        ["cache_read_input_tokens", "cache_creation_input_tokens"].every(key => rawUsage[key] === undefined || (Number.isSafeInteger(rawUsage[key]) && rawUsage[key] >= 0));
      const usage = client === "claude" && countsValid ? {
        input_tokens: (rawUsage.input_tokens || 0) + (rawUsage.cache_read_input_tokens || 0) + (rawUsage.cache_creation_input_tokens || 0),
        cached_input_tokens: rawUsage.cache_read_input_tokens || 0, cache_write_input_tokens: rawUsage.cache_creation_input_tokens || 0, output_tokens: rawUsage.output_tokens || 0,
      } : null;
      return { turnCompleted: Boolean(result), protocolSuccess: Boolean(successful) && errors.length === 0, final, usage, rawUsage: rawUsage ?? null, errors, warnings };
    },
  };
}

export function clientDriver(client, cli) {
  if (client === "codex") return codexDriver(cli);
  if (!["claude", "gemini"].includes(client)) throw new Error(`Unsupported client: ${client}`);
  return async ({ root, model, prompt, budget, outputDirectory }) => {
    const args = clientArguments(client, model, budget);
    const script = /\.(m?js)$/i.test(cli);
    const result = await new Promise(resolve => {
      const started = Date.now(), startedAt = new Date(started).toISOString();
      const timing = createToolTiming(), reader = createClientEventReader(client, timing);
      const child = spawn(script ? process.execPath : cli, script ? [cli, ...args] : args, { cwd: root, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", pending = "", timedOut = false, toolLimit = false, error = null, unparsedLines = 0;
      const stop = () => {
        if (child.exitCode !== null || !child.pid) return;
        if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGKILL");
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, budget.timeoutMs);
      const line = raw => {
        if (!raw.trim()) return;
        let event; try { event = JSON.parse(raw); } catch { unparsedLines++; return; }
        reader.accept(event, Date.now()-started);
        if (reader.toolCalls >= budget.maxToolCalls) { toolLimit = true; stop(); }
      };
      child.stdout.on("data", chunk => { stdout += chunk; pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop(); for (const value of lines) line(value); });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.stdin.on("error", failure => { error ||= redact(failure.message); });
      child.once("error", failure => { error = redact(failure.message); });
      child.once("close", exitCode => {
        clearTimeout(timer); line(pending);
        const durationMs = Date.now()-started;
        const response = reader.finish();
        resolve({ mode: "real", client, startedAt, durationMs, exitCode, timedOut, toolLimit, error, toolCalls: reader.toolCalls, timing: timing.summarize(durationMs), unparsedLines, ...response,
          completed: exitCode === 0 && !timedOut && !toolLimit && !error && unparsedLines === 0 && response.protocolSuccess && response.final?.completed === true,
          stdout: redact(stdout), stderr: redact(stderr), executionPolicy: client === "claude" ? "dontAsk with explicit tool allowlist; no OS sandbox claim" : "sandbox and auto_edit; interactive permission refusals are failures" });
      });
      child.stdin.end(prompt);
    });
    await writeFile(path.join(outputDirectory, "events.jsonl"), result.stdout);
    await writeFile(path.join(outputDirectory, "stderr.txt"), result.stderr);
    if (result.final) await writeFile(path.join(outputDirectory, "final.json"), JSON.stringify(result.final, null, 2) + "\n");
    return { ...result, stdout: undefined, stderr: undefined };
  };
}
