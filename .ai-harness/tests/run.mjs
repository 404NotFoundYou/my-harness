import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const directory = path.dirname(fileURLToPath(import.meta.url));
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(directory, name));

const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: path.resolve(directory, "..", ".."),
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

process.exitCode = typeof result.status === "number" ? result.status : 1;
