import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, ["D:/Program Files/nodejs/node_global/node_modules/@openai/codex/bin/codex.js", "app-server", "--stdio"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
const lines = createInterface({ input: child.stdout });
const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("model catalog timeout")), 30000);
  child.once("error", reject);
  child.stderr.resume();
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === 0) {
      if (message.error) { clearTimeout(timer); reject(new Error(message.error.message)); return; }
      send({ method: "initialized", params: {} });
      send({ id: 1, method: "model/list", params: {} });
    }
    if (message.id === 1) { clearTimeout(timer); resolve(message); }
  });
  send({ id: 0, method: "initialize", params: { clientInfo: { name: "harness_catalog", version: "1.0.0" } } });
}).finally(() => { child.stdin.end(); lines.close(); child.kill(); });
const models = (result.result?.data || []).map((model) => ({ id: model.id, model: model.model, displayName: model.displayName, defaultReasoningEffort: model.defaultReasoningEffort, supportedReasoningEfforts: model.supportedReasoningEfforts, isDefault: model.isDefault }));
const output = { checkedAt: new Date().toISOString(), error: result.error?.message || null, models, nextCursor: result.result?.nextCursor ?? null };
await writeFile(fileURLToPath(new URL("./model-catalog.json", import.meta.url)), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify(output));
