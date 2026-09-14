import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceSnapshot } from "../../src/snapshot.mjs";

const root = process.cwd();
const files = [];
for (const directory of [".ai-harness/src", ".ai-harness/bin"]) {
  for (const name of await readdir(path.join(root, directory))) if (name.endsWith(".mjs")) files.push(`${directory}/${name}`);
}
const failures = [];
for (const file of files) {
  const syntax = spawnSync(process.execPath, ["--check", file], { cwd: root, shell: false, windowsHide: true, encoding: "utf8" });
  if (syntax.status !== 0) failures.push({ file, rule: "node-syntax", error: syntax.stderr });
  const text = await readFile(path.join(root, file), "utf8");
  if (/\bshell\s*:\s*true\b/.test(text)) failures.push({ file, rule: "no-shell-true" });
  if (/\b(?:eval|Function)\s*\(/.test(text)) failures.push({ file, rule: "no-dynamic-js-evaluation" });
}
const result = { source: (await sourceSnapshot(root)).digest, checkedFiles: files, syntaxChecks: files.length, staticRules: ["no-shell-true", "no-dynamic-js-evaluation"], failures, limitation: "仅验证列出的语法和项目特定静态规则，不是完整漏洞扫描。" };
await writeFile(fileURLToPath(new URL("./static-result.json", import.meta.url)), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
if (failures.length) process.exitCode = 1;
