import { writeFileSync } from "node:fs";
try {
  writeFileSync(process.argv[2], "owned confinement probe\n");
  console.log(JSON.stringify({ outsideWriteDenied: false }));
  process.exitCode = 1;
} catch (error) {
  const denied = ["EACCES", "EPERM"].includes(error.code);
  console.log(JSON.stringify({ outsideWriteDenied: denied, errorCode: error.code }));
  if (!denied) process.exitCode = 1;
}
