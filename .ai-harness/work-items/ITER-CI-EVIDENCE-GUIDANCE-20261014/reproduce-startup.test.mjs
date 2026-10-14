import fsPromises from "node:fs/promises";
import { mock } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const write = fsPromises.writeFile;
mock.method(fsPromises, "writeFile", async (...args) => {
  if (String(args[0]).includes("response.schema.json")) await delay(350);
  return write(...args);
});
syncBuiltinESMExports();
await import("../../../benchmarks/tests/driver-process.test.mjs");
