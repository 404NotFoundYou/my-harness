import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "../../src/evidence.mjs";
const root = process.cwd();
const parent = path.dirname(root);
const target = await mkdtemp(path.join(parent, "harness-confinement-"));
try {
  const worker = fileURLToPath(new URL("./confinement-worker.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["D:/Program Files/nodejs/node_global/node_modules/@openai/codex/bin/codex.js", "sandbox", "-P", ":workspace", "-C", root, "--", process.execPath, worker, path.join(target, "blocked.txt")], { cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 30000 });
  const output = { exitCode: result.status, stdout: redact(result.stdout || ""), stderr: redact(result.stderr || "") };
  await writeFile(fileURLToPath(new URL("./confinement-result.json", import.meta.url)), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output));
  process.exitCode = typeof result.status === "number" ? result.status : 1;
} finally {
  if (path.dirname(target) === parent && path.basename(target).startsWith("harness-confinement-")) await rm(target, { recursive: true, force: true });
}
