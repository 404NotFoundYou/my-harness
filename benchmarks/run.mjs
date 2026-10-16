import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientDriver } from "./client-drivers.mjs";
import { cliIdentity, experimentPlan, runExperiment } from "./experiment.mjs";
import { loadContainerRuntime } from "./codex-container.mjs";

const options = {};
const keys = ["--cli", "--weak", "--strong", "--out", "--client", "--comparison", "--repetitions", "--timeout-ms", "--max-tools", "--suite", "--codex-runtime", "--codex-container-manifest", "--dry-run", "--resume"];
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!keys.includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or repeated option: ${key}`);
  if (["--dry-run","--resume"].includes(key)) options[key] = true;
  else {
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
    options[key] = value;
  }
}
for (const key of ["--weak", "--out"]) if (!options[key]) throw new Error(`Missing ${key}`);
if(options["--resume"]&&options["--dry-run"])throw new Error("--resume cannot be combined with --dry-run");
const codexRuntime=options["--codex-runtime"]||"host",client=options["--client"]||"codex";
if(!["host","docker"].includes(codexRuntime))throw new Error("--codex-runtime must be host or docker");
if(codexRuntime === "host"){
  if(!options["--cli"])throw new Error("Missing --cli");
  if(options["--codex-container-manifest"])throw new Error("--codex-container-manifest requires --codex-runtime docker");
}else{
  if(client !== "codex")throw new Error("Docker runtime is only supported for Codex");
  if(options["--cli"])throw new Error("--cli cannot be combined with --codex-runtime docker");
  if(!options["--codex-container-manifest"])throw new Error("Missing --codex-container-manifest");
}
const plan = experimentPlan({ weak: options["--weak"], strong: options["--strong"], client, comparison: options["--comparison"], suite: options["--suite"],
  repetitions: options["--repetitions"] === undefined ? undefined : Number(options["--repetitions"]),
  timeoutMs: options["--timeout-ms"] === undefined ? undefined : Number(options["--timeout-ms"]),
  maxToolCalls: options["--max-tools"] === undefined ? undefined : Number(options["--max-tools"]) });
if (options["--dry-run"]) console.log(JSON.stringify({ ...plan, codexRuntime, modelCalls: plan.schedule.length, dryRun: true }, null, 2));
else {
  const selected=codexRuntime === "docker" ? await loadContainerRuntime(options["--codex-container-manifest"]) : null;
  const identity=selected?.identity??await cliIdentity(options["--cli"],{codexEnvironment:plan.client === "codex"});
  const result = await runExperiment({ plan, sourceRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), outputDirectory: path.resolve(options["--out"]),
    driver: clientDriver(plan.client, selected?.cli??identity.entry, selected?{runtime:selected.runtime}:{}), driverIdentity:identity, readDriverIdentity:selected?.readIdentity,
    resume:Boolean(options["--resume"]), onProgress: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ event: result.complete?"complete":"incomplete", groups: result.groups, progress:result.progress,interrupted:result.interrupted,notRun:result.notRun }));
  process.exitCode=result.complete?0:1;
}
