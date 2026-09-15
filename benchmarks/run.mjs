import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientDriver } from "./client-drivers.mjs";
import { experimentPlan, runExperiment } from "./experiment.mjs";

const options = {};
const keys = ["--cli", "--weak", "--strong", "--out", "--client", "--comparison", "--repetitions", "--timeout-ms", "--max-tools", "--suite", "--dry-run"];
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index];
  if (!keys.includes(key) || Object.hasOwn(options, key)) throw new Error(`Unknown or repeated option: ${key}`);
  if (key === "--dry-run") options[key] = true;
  else {
    const value = process.argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value: ${key}`);
    options[key] = value;
  }
}
for (const key of ["--cli", "--weak", "--out"]) if (!options[key]) throw new Error(`Missing ${key}`);
const plan = experimentPlan({ weak: options["--weak"], strong: options["--strong"], client: options["--client"], comparison: options["--comparison"], suite: options["--suite"],
  repetitions: options["--repetitions"] === undefined ? undefined : Number(options["--repetitions"]),
  timeoutMs: options["--timeout-ms"] === undefined ? undefined : Number(options["--timeout-ms"]),
  maxToolCalls: options["--max-tools"] === undefined ? undefined : Number(options["--max-tools"]) });
if (options["--dry-run"]) console.log(JSON.stringify({ ...plan, modelCalls: plan.schedule.length, dryRun: true }, null, 2));
else {
  const result = await runExperiment({ plan, sourceRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), outputDirectory: path.resolve(options["--out"]),
    driver: clientDriver(plan.client, options["--cli"]), onProgress: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ event: "complete", groups: result.groups }));
}
