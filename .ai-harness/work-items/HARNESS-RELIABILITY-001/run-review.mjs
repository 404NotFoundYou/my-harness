import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sourceSnapshot } from "../../src/snapshot.mjs";
import { redact } from "../../src/evidence.mjs";
const directory = path.dirname(fileURLToPath(import.meta.url));
const attempt = process.argv[2] || "1";
const focused = ["4", "5"].includes(attempt);
const suffix = attempt === "1" ? "" : `-${attempt}`;
const before = await sourceSnapshot(process.cwd());
const output = path.join(directory, `independent-review${suffix}.json`);
const args = ["D:/Program Files/nodejs/node_global/node_modules/@openai/codex/bin/codex.js", "exec", "--ephemeral", "--json", "--color", "never", "--sandbox", "read-only", "-C", process.cwd(), "-m", "gpt-5.6-sol", "-c", focused ? 'model_reasoning_effort="medium"' : 'model_reasoning_effort="high"', "--output-schema", path.join(directory, "review-schema.json"), "-o", output, "-"];
let prompt = await readFile(path.join(directory, "review-prompt.txt"), "utf8");
if (attempt === "4") prompt = "请做一次有明确范围的独立只读代码复核，不修改文件或创建工作项。上一轮已完整审查4acb4404版本，只剩commandKey将显式路径归一为basename这一项缺陷（下面是原结果）。现在仅commands.mjs及两份回归测试相对上轮改变：显式路径保留规范化身份，裸命令不随意删除扩展名，仅当前Node与node/node.exe等价，实际执行强制使用process.execPath。请复核这处修复、直接调用方匹配语义和兼容性，确认则pass，确认缺陷则changes_requested。无需重新扫描其它未变动模块；不报告风格建议。上轮结果：\n" + await readFile(path.join(directory, "independent-review-3.json"), "utf8");
if (attempt === "5") prompt = "请独立只读复核上一轮唯一P2修复，不修改文件或创建工作项。相对上一轮审查，产品只修改policy.mjs：导入commandKey，将显式路径是否等于当前Node的比较改为commandKey(command,[])===commandKey(process.execPath,[])，使策略、身份匹配、实际启动共用等价规则。reliability.test.mjs新加Windows大写路径的真实run和finish回归，已从COMMAND_REQUIRES_APPROVAL失败变为通过。下面附源码，确认修复则pass，确认仍有本次引入的缺陷则changes_requested。无需再扫描未变化的工作流模块。此前引用的短哈希是代码快照digest，不是Git提交。上一轮已确认原P1修复有效。上一轮结果：\n" + await readFile(path.join(directory, "independent-review-4.json"), "utf8");
if (attempt !== "1") {
  prompt += "\n\n第一次审查因大量重复读取而超时，以下是当前版本所需源码全文。请直接基于这些材料完成审查，只有确有材料缺口才追加读取；输出最重要且可确认的发现。\n";
  for (const file of (focused ? ["commands", "verification", "evidence", "policy"] : ["commands", "snapshot", "verification", "scope", "evidence", "workflow", "validator", "compact", "guide", "policy", "cli", "model", "git", "filesystem", "constants"])) {
    const relative = `.ai-harness/src/${file}.mjs`;
    const content = await readFile(path.join(process.cwd(), relative), "utf8");
    prompt += `\nFILE ${relative}\n` + content.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join("\n") + "\nEND FILE\n";
  }
}
const result = await new Promise((resolve) => {
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const started = Date.now();
  let stdout = "", stderr = "", timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  }, attempt === "1" ? 240000 : 600000);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => { clearTimeout(timer); resolve({ exitCode: 1, error: redact(error.message) }); });
  child.once("close", (exitCode) => { clearTimeout(timer); resolve({ exitCode, timedOut, durationMs: Date.now() - started, stdout: redact(stdout), stderr: redact(stderr) }); });
  child.stdin.end(prompt);
});
const after = await sourceSnapshot(process.cwd());
await writeFile(path.join(directory, `independent-review${suffix}-events.jsonl`), result.stdout || "");
const summary = { ...result, stdout: undefined, stderr: result.stderr?.slice(-2000), sourceBefore: before.digest, sourceAfter: after.digest, unchanged: before.digest === after.digest };
await writeFile(path.join(directory, `independent-review${suffix}-run.json`), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
if (result.exitCode !== 0 || !summary.unchanged) process.exitCode = 1;
