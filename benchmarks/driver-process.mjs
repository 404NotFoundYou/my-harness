import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let supervisor;
function windowsSupervisor() {
  if (supervisor) return supervisor;
  const directory = mkdtempSync(path.join(tmpdir(), "ai-harness-job-"));
  const executable = path.join(directory, "supervisor.exe");
  const cleanup = () => { rmSync(executable, { force: true }); rmdirSync(directory); };
  try {
    const compiler = path.join(process.env.SystemRoot, "Microsoft.NET/Framework/v4.0.30319/csc.exe");
    execFileSync(compiler, ["/nologo", "/noconfig", "/reference:System.dll", "/target:exe", "/out:" + executable, fileURLToPath(new URL("./windows-job.cs", import.meta.url))], { windowsHide: true, timeout: 30000 });
  } catch (error) { cleanup(); throw error; }
  process.once("exit", cleanup);
  supervisor = executable;
  return supervisor;
}

export function prepareDriverSpawn() {
  if (process.platform !== "win32") return spawn;
  const launcher = windowsSupervisor();
  return (command, args, options) => spawn(launcher, [command, ...args], { ...options, stdio: [...options.stdio, "pipe"] });
}

export function observeDriverExit(child, exited) {
  // On Windows the client can exit before descendants close its output pipes.
  child.stdio?.[3]?.once("data", exited);
  child.once("exit", exited);
}

export function stopDriver(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    child.kill(); // Terminate the supervisor by its process handle, never a recycled CLI PID.
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}
