#!/usr/bin/env node
import { runCli, renderError } from "../src/cli.mjs";

const json = process.argv.includes("--json");
try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  console.error(renderError(error, json));
  process.exitCode = 1;
}
