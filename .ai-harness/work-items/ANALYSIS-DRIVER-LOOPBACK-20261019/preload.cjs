const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const cli = "/opt/codex/lib/node_modules/@openai/codex/bin/codex.js";
if (process.argv[1] === cli && process.argv[2] === "exec") {
  const home = process.env.CODEX_HOME;
  const mode = fs.readFileSync("/workspace/fixture-mode.txt", "utf8").trim();
  if (!["success", "timeout"].includes(mode)) throw new Error("Invalid fixture mode");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model_provider="fixed_local"',
    '[model_providers.fixed_local]',
    'name="Container-local fixed response"',
    'base_url="http://127.0.0.1:37555/v1"',
    'wire_api="responses"',
    'requires_openai_auth=false',
    'supports_websockets=false',
    'request_max_retries=0',
    'stream_max_retries=0',
    '[analytics]',
    'enabled=false',
    '',
  ].join("\n"));
  const ready = "/tmp/fixed-response-ready";
  try { fs.unlinkSync(ready); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const child = spawn(process.execPath, ["/opt/fixture/server.cjs"], {
    detached: true, stdio: "ignore", env: { ...process.env, NODE_OPTIONS: "", FIXTURE_MODE: mode },
  });
  child.unref();
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 150 && !fs.existsSync(ready); attempt++) Atomics.wait(wait, 0, 0, 20);
  if (!fs.existsSync(ready)) throw new Error("Fixed responder did not start");
}
