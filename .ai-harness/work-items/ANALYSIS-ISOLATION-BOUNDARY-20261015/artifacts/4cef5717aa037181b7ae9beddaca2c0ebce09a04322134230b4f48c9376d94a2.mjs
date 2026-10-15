import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const cli = process.argv[2];
assert.ok(cli && /\.m?js$/i.test(cli), "An explicit Node CLI entry is required");
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), "runtime-context-diagnostic.json");
const root = await mkdtemp(path.join(await realpath(tmpdir()), "ai-harness-runtime-context-"));
const home = path.join(root, "home"), workspace = path.join(root, "workspace");
const memoryMarker = "MEMORY_" + randomUUID(), contextMarker = "CONTEXT_" + randomUUID();
const sha = value => createHash("sha256").update(value).digest("hex");
const report = { recordedAt: new Date().toISOString(), actualModelCalls: 0, simulatedCliSessions: 0, platform: process.platform, node: process.version, cliEntrySha256: sha(await readFile(cli)), rows: [], diagnosticPassed: false, runtimeMemoryControlVerified: false, filesystemIsolationVerified: false };
let active;
const server = http.createServer(async (request, response) => {
  const buffers = []; let bytes = 0;
  for await (const buffer of request) { bytes += buffer.length; if (bytes > 16 * 1024 * 1024) { response.writeHead(413).end(); return; } buffers.push(buffer); }
  if (!active || request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
  const raw = Buffer.concat(buffers).toString("utf8");
  let payload;
  try { payload = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
  active.requests.push({ path: request.url, model: payload.model, contextMarkerPresent: raw.includes(contextMarker), memoryMarkerPresent: raw.includes(memoryMarker), authorizationHeaderPresent: Boolean(request.headers.authorization), requestSha256: sha(raw) });
  const item = { id: "msg_local_diagnostic", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "LOCAL_DIAGNOSTIC_DONE", annotations: [] }] };
  const completed = { id: "resp_local_diagnostic", object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model: payload.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "close" });
  for (const event of [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ]) response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
  response.end();
});
function execute(args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["path", "pathext", "systemroot", "windir", "temp", "tmp", "systemdrive", "comspec", "programdata"].includes(key.toLowerCase())));
  Object.assign(env, { CODEX_HOME: home, USERPROFILE: home, HOME: home });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: workspace, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderrBytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 4 * 1024 * 1024) child.kill(); });
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, timedOut, stdout, stderrBytes }); });
  });
}
try {
  await mkdir(home); await mkdir(workspace); await mkdir(path.join(home, "memories"));
  for (const name of ["memory_summary.md", "MEMORY.md"]) await writeFile(path.join(home, "memories", name), memoryMarker + "\n");
  await writeFile(path.join(home, "AGENTS.md"), contextMarker + "\n");
  const version = await execute(["--version"]); assert.equal(version.exitCode, 0); assert.equal(version.stdout.trim(), "codex-cli 0.156.0"); report.cliVersion = version.stdout.trim();
  const catalog = await execute(["debug", "models", "--bundled"]); assert.equal(catalog.exitCode, 0); JSON.parse(catalog.stdout);
  const catalogPath = path.join(root, "models.json"); await writeFile(catalogPath, catalog.stdout);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
  await writeFile(path.join(home, "config.toml"), 'model="gpt-6-astra"\nmodel_provider="local_diagnostic"\nmodel_catalog_json=' + JSON.stringify(catalogPath) + '\n[model_providers.local_diagnostic]\nname="Loopback fixed diagnostic response"\nbase_url=' + JSON.stringify(baseUrl) + '\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n[features]\nmemories=true\n[memories]\nversion="v1"\nuse_memories=true\ngenerate_memories=false\n[analytics]\nenabled=false\n');
  report.endpoint = baseUrl;
  for (const disabled of [false, true]) {
    active = { disabled, requests: [] };
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--json", ...(disabled ? ["--disable", "memories"] : []), "Return the fixed local diagnostic response. Do not use tools."];
    report.simulatedCliSessions++;
    const result = await execute(args);
    const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { type: "unparsed" }; } });
    const row = { ...active, args, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, stderrBytes: result.stderrBytes, stdoutSha256: sha(result.stdout), eventTypes: events.map(event => event.type), completed: events.some(event => event.type === "turn.completed"), toolCalls: events.filter(event => event.item?.type === "command_execution" || event.item?.type === "mcp_tool_call").length };
    report.rows.push(row); active = undefined;
    assert.equal(row.exitCode, 0, "Simulated CLI session failed"); assert.equal(row.timedOut, false); assert.equal(row.completed, true, "CLI must accept the fixed response"); assert.equal(row.toolCalls, 0, "Diagnostic must not execute model-selected tools");
    assert.equal(row.requests.length, 1, "Each simulated session must make exactly one loopback request");
    assert.equal(row.requests[0].model, "gpt-6-astra"); assert.equal(row.requests[0].authorizationHeaderPresent, false, "No credentials may be sent");
    assert.equal(row.requests[0].contextMarkerPresent, true, "Ordinary synthetic context must reach the real runtime request");
    assert.equal(row.requests[0].memoryMarkerPresent, !disabled, "Actual runtime must inject enabled synthetic memory and omit disabled memory");
  }
  report.diagnosticPassed = true; report.runtimeMemoryControlVerified = true;
  report.boundary = "Two actual CLI processes use a loopback fixed responder without inference or forwarding. Synthetic memory injection is verified in this local provider runtime only; no real model behavior, host-memory file access isolation, external MCP, or paid benchmark is verified.";
} catch (error) {
  report.error = { code: error.code || null, message: error.message }; process.exitCode = 1;
} finally {
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(root), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith("ai-harness-runtime-context-"));
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
