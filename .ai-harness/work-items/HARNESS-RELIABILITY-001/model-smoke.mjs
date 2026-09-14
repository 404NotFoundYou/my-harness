import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../../src/evidence.mjs";

const root = await mkdtemp(path.join(tmpdir(), "ai-harness-model-smoke-"));
spawnSync("git", ["init"], { cwd: root, windowsHide: true, stdio: "ignore" });
const results = [];
try {
  for (const model of ["gpt-5.6-luna", "gpt-5.6-sol"]) {
    const args = ["D:/Program Files/nodejs/node_global/node_modules/@openai/codex/bin/codex.js", "exec", "--ephemeral", "--json", "--color", "never", "--sandbox", "read-only", "-C", root, "-m", model, "-c", 'model_reasoning_effort="low"', "-"];
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const started = Date.now();
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }, 45000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => { clearTimeout(timer); resolve({ model, error: redact(error.message) }); });
      child.once("close", (code) => {
        clearTimeout(timer);
        const events = stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        resolve({ model, exitCode: code, timedOut, durationMs: Date.now() - started,
          messages: events.filter((event) => event.item?.type === "agent_message").map((event) => redact(event.item.text)),
          usage: events.findLast((event) => event.type === "turn.completed")?.usage || null,
          errors: events.filter((event) => ["error", "turn.failed"].includes(event.type)).map((event) => redact(JSON.stringify(event))),
          stderr: redact(stderr).slice(-1600) });
      });
      child.stdin.end("只回复 READY，不使用任何工具。\n");
    });
    results.push(result);
    console.log(JSON.stringify(result));
  }
} finally {
  const relative = path.relative(tmpdir(), root);
  if (!relative.startsWith("..") && path.basename(root).startsWith("ai-harness-model-smoke-")) await rm(root, { recursive: true, force: true });
}
await writeFile(fileURLToPath(new URL("./model-smoke.json", import.meta.url)), JSON.stringify(results, null, 2) + "\n");
