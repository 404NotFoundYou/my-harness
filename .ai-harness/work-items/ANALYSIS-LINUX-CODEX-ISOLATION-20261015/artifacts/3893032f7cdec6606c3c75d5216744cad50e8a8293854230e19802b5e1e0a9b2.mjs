import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";

const digest = (algorithm, bytes, encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const packageSpecs = [
  {
    file: "/packages/openai-codex-0.156.0.tgz",
    destination: "/opt/runtime/lib/node_modules/@openai/codex",
    sha256: "5ce491a5ba3c0c2489594dfb6807c7c0b51166882e080772659f06f0c1fdc5d6",
    integrity: "sha512-47dfpl2e8F47baSQTE+QaWzF/kKoOeR9YQ2fIBdRGzZZP2/QZ6D0uwLY2ZamS8ypov4UFtg92jZh8m+w65bsGg==",
  },
  {
    file: "/packages/openai-codex-0.156.0-linux-x64.tgz",
    destination: "/opt/runtime/lib/node_modules/@openai/codex-linux-x64",
    sha256: "e16d3ee5f51562cdb83a523ac5f2b8929fe4693c744e1484d478112f52e3a239",
    integrity: "sha512-/PX399ISB715skgBBOtOX5aqLxmPQhYC7wDasZnAJhRrtzt3qgs6kjSnimN9T8OFKv4LDAp+uJdN896tQYaTrA==",
  },
];

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  actualModelCalls: 0,
  simulatedCliSessions: 0,
  localProviderRequests: 0,
  realMemoryPathsAccessed: 0,
  packageInstall: [],
  identity: {},
  memoryRows: [],
  tool: {},
  verified: false,
  boundary: "",
};

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", shell: false, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.error, undefined, `${executable} could not start`);
  assert.equal(result.signal, null, `${executable} was terminated by a signal`);
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`);
  return result.stdout;
}

for (const spec of packageSpecs) {
  const bytes = await readFile(spec.file);
  assert.equal(digest("sha256", bytes), spec.sha256, `Package SHA-256 mismatch: ${spec.file}`);
  assert.equal(`sha512-${digest("sha512", bytes, "base64")}`, spec.integrity, `Package integrity mismatch: ${spec.file}`);
  await mkdir(spec.destination, { recursive: true });
  command("tar", ["-xzf", spec.file, "-C", spec.destination, "--strip-components=1"]);
  report.packageInstall.push({ file: path.basename(spec.file), bytes: bytes.length, sha256: spec.sha256, destination: spec.destination });
}
await mkdir("/opt/runtime/bin", { recursive: true });
await symlink("/opt/runtime/lib/node_modules/@openai/codex/bin/codex.js", "/opt/runtime/bin/codex");

const wrapper = "/opt/runtime/lib/node_modules/@openai/codex/bin/codex.js";
const nativeBinary = "/opt/runtime/lib/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
const cli = args => command(process.execPath, [wrapper, ...args], { env: process.env, cwd: "/probe/workspace" });
report.identity = {
  node: process.version,
  cliVersion: cli(["--version"]).trim(),
  wrapperSha256: digest("sha256", await readFile(wrapper)),
  nativeBinarySha256: digest("sha256", await readFile(nativeBinary)),
};
assert.equal(report.identity.node, "v22.20.0");
assert.equal(report.identity.cliVersion, "codex-cli 0.156.0");

const codexHome = "/tmp/codex-home";
const contextMarker = `CONTEXT_${randomUUID()}`;
const memoryMarker = `MEMORY_${randomUUID()}`;
await mkdir(path.join(codexHome, "memories"), { recursive: true });
await writeFile(path.join(codexHome, "AGENTS.md"), contextMarker + "\n");
await writeFile(path.join(codexHome, "memories", "memory_summary.md"), memoryMarker + "\n");
await writeFile(path.join(codexHome, "memories", "MEMORY.md"), memoryMarker + "\n");
const catalog = cli(["debug", "models", "--bundled"]);
JSON.parse(catalog);
const catalogPath = "/tmp/models.json";
await writeFile(catalogPath, catalog);

function responseCreated(id) { return { type: "response.created", response: { id } }; }
function completed(id) { return { type: "response.completed", response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }; }
function assistantMessage(id, text) { return { type: "response.output_item.done", item: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] } }; }
function functionCall(callId, name, args) { return { type: "response.output_item.done", item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(args) } }; }
function sendEvents(response, events) {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}
function nestedStrings(value, rows = []) {
  if (typeof value === "string") rows.push(value);
  else if (Array.isArray(value)) for (const entry of value) nestedStrings(entry, rows);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) nestedStrings(entry, rows);
  return rows;
}
function parseToolOutput(payload, callId) {
  for (const item of Array.isArray(payload.input) ? payload.input : []) {
    if (item?.type !== "function_call_output" || item.call_id !== callId) continue;
    for (const output of nestedStrings(item.output)) {
      const marker = output.indexOf("TOOL_RESULT=");
      if (marker < 0) continue;
      const row = output.slice(marker + "TOOL_RESULT=".length).split(/\r?\n/, 1)[0].trim();
      return { result: JSON.parse(row), outputSha256: digest("sha256", JSON.stringify(item.output)) };
    }
  }
  return null;
}

let active;
const server = http.createServer(async (request, response) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) { response.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  if (!active || request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
  const raw = Buffer.concat(chunks).toString("utf8");
  const payload = JSON.parse(raw);
  const requestRecord = {
    requestSha256: digest("sha256", raw),
    model: payload.model ?? null,
    contextMarkerPresent: raw.includes(contextMarker),
    memoryMarkerPresent: raw.includes(memoryMarker),
    authorizationHeaderPresent: Boolean(request.headers.authorization),
    toolNames: (payload.tools ?? []).map(tool => ({ keys: Object.keys(tool).sort(), type: tool.type ?? null, name: tool.name ?? tool.function?.name ?? null, functionName: tool.function?.name ?? null, namespace: tool.namespace ?? null })),
  };
  active.requests.push(requestRecord);
  report.localProviderRequests++;
  if (active.mode === "tool" && active.requests.length === 1) {
    if (requestRecord.toolNames.some(tool => tool.name === "exec_command")) {
      sendEvents(response, [
        responseCreated("resp-tool-1"),
        functionCall(active.callId, "exec_command", { cmd: "/usr/local/bin/node /tmp/tool-probe.mjs", login: false, yield_time_ms: 10_000 }),
        completed("resp-tool-1"),
      ]);
    } else {
      active.unsupportedToolSet = requestRecord.toolNames;
      sendEvents(response, [responseCreated("resp-tool-unsupported"), assistantMessage("msg-tool-unsupported", "EXEC_COMMAND_NOT_EXPOSED"), completed("resp-tool-unsupported")]);
    }
    return;
  }
  if (active.mode === "tool") {
    const parsed = parseToolOutput(payload, active.callId);
    active.toolResult = parsed?.result ?? null;
    requestRecord.toolOutputSha256 = parsed?.outputSha256 ?? null;
    requestRecord.inputTypes = (payload.input ?? []).map(item => item?.type ?? null);
  }
  sendEvents(response, [responseCreated(`resp-${active.mode}-${active.requests.length}`), assistantMessage(`msg-${active.mode}`, "LOCAL_FIXED_DONE"), completed(`resp-${active.mode}-${active.requests.length}`)]);
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await writeFile(path.join(codexHome, "config.toml"), [
  'model="gpt-6-astra"',
  'model_provider="local_diagnostic"',
  `model_catalog_json=${JSON.stringify(catalogPath)}`,
  '[model_providers.local_diagnostic]',
  'name="Loopback fixed diagnostic response"',
  `base_url=${JSON.stringify(baseUrl)}`,
  'wire_api="responses"',
  'requires_openai_auth=false',
  'supports_websockets=false',
  'request_max_retries=0',
  'stream_max_retries=0',
  '[features]',
  'memories=true',
  '[memories]',
  'version="v1"',
  'use_memories=true',
  'generate_memories=false',
  '[analytics]',
  'enabled=false',
  '',
].join("\n"));

const cliEnv = { ...process.env, CODEX_HOME: codexHome, HOME: "/tmp/home", PATH: "/opt/runtime/bin:/usr/local/bin:/usr/bin:/bin" };
function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, ...args], { cwd: "/probe/workspace", env: cliEnv, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, stdout, stderr }); });
  });
}
function eventTypes(stdout) { return stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line).type; } catch { return "unparsed"; } }); }

try {
  for (const disabled of [false, true]) {
    active = { mode: disabled ? "memory-off" : "memory-on", requests: [] };
    report.simulatedCliSessions++;
    const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--json", ...(disabled ? ["--disable", "memories"] : []), "Return the fixed local response without tools."];
    const result = await execute(args);
    assert.equal(result.exitCode, 0, `Memory session failed: ${result.stderr}`);
    assert.equal(result.signal, null);
    assert.equal(active.requests.length, 1);
    assert.equal(active.requests[0].authorizationHeaderPresent, false);
    assert.equal(active.requests[0].contextMarkerPresent, true);
    assert.equal(active.requests[0].memoryMarkerPresent, !disabled);
    report.memoryRows.push({ disabled, request: active.requests[0], eventTypes: eventTypes(result.stdout), stderrBytes: Buffer.byteLength(result.stderr), completed: eventTypes(result.stdout).includes("turn.completed") });
  }

  await writeFile("/tmp/tool-probe.mjs", 'import{readFileSync}from"node:fs";const rows=[];for(const[file,expected]of[["/probe/workspace/inside.txt","inside-canary"],["/probe/external/outside.txt","outside-canary"],["/probe/host-memory/MEMORY.md","memory-canary"]]){try{rows.push({readable:true,matches:readFileSync(file,"utf8")===expected});}catch(error){rows.push({readable:false,code:error.code});}}console.log("TOOL_RESULT="+JSON.stringify(rows));\n');
  active = { mode: "tool", requests: [], callId: "exec-command-isolation", toolResult: null };
  report.simulatedCliSessions++;
  const toolResult = await execute(["exec", "--ephemeral", "--skip-git-repo-check", "--json", "--disable", "memories", "--dangerously-bypass-approvals-and-sandbox", "-c", 'model="gpt-5.4"', "Run the requested fixed command once."]);
  assert.equal(toolResult.exitCode, 0, `Tool session failed: ${toolResult.stderr}`);
  assert.equal(toolResult.signal, null);
  assert.equal(active.unsupportedToolSet, undefined, `exec_command not exposed: ${JSON.stringify(active.unsupportedToolSet)}`);
  assert.equal(active.requests[0].model, "gpt-5.4");
  assert.equal(active.requests.length, 2);
  assert.deepEqual(active.toolResult, [
    { readable: true, matches: true },
    { readable: false, code: "ENOENT" },
    { readable: false, code: "ENOENT" },
  ]);
  report.tool = {
    codexSandboxBypassed: true,
    outerDockerBoundaryRequired: true,
    requests: active.requests,
    result: active.toolResult,
    eventTypes: eventTypes(toolResult.stdout),
    stderrBytes: Buffer.byteLength(toolResult.stderr),
    completed: eventTypes(toolResult.stdout).includes("turn.completed"),
  };
  report.verified = report.memoryRows.every(row => row.completed) && report.tool.completed;
  report.boundary = "Verified real Linux Codex 0.156.0 request memory controls and exec_command dispatch against a loopback fixed responder. exec_command intentionally bypassed the inner Codex sandbox and remained bounded by the outer hardened Docker container. External MCP and nested bwrap sandbox remain unverified.";
} catch (error) {
  report.error = { code: error.code ?? null, message: error.message };
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

console.log("RUNTIME_PROBE_RESULT=" + JSON.stringify(report));
