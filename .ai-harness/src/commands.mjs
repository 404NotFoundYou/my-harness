import path from "node:path";
import { stat } from "node:fs/promises";
import { invariant } from "./errors.mjs";

export function commandName(command) {
  return command.replaceAll("\\", "/").split("/").at(-1).toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
}

export function isValidCheckTimeoutMs(value) {
  return Number.isInteger(value) && value >= 1 && value <= 1800000;
}

export function parseCommand(value) {
  if (typeof value === "object" && value !== null) {
    invariant(typeof value.command === "string" && value.command.trim() && Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"), "INVALID_VERIFICATION_COMMAND", "验证声明需要 command 和字符串 args 数组。" );
    if (value.acceptance !== undefined) invariant(Array.isArray(value.acceptance) && value.acceptance.length > 0 && value.acceptance.every(id => typeof id === "string" && /^A[1-9]\d*$/.test(id)) && new Set(value.acceptance).size === value.acceptance.length, "INVALID_ACCEPTANCE_MAPPING", "acceptance 需要不重复的验收编号数组，例如 [A1]。" );
    if (value.timeoutMs !== undefined) invariant(isValidCheckTimeoutMs(value.timeoutMs), "INVALID_CHECK_TIMEOUT", "检查 timeoutMs 必须是 1 到 1800000 之间的整数。" );
    return { command: value.command, args: [...value.args], ...(value.acceptance === undefined ? {} : { acceptance: [...value.acceptance] }), ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }) };
  }
  invariant(typeof value === "string" && value.trim(), "INVALID_VERIFICATION_COMMAND", "验证必须声明实际命令。" );
  if (value.trimStart().startsWith("{")) {
    let parsed;
    try { parsed = JSON.parse(value); } catch { invariant(false, "INVALID_VERIFICATION_COMMAND", "结构化验证命令不是有效 JSON。" ); }
    return parseCommand(parsed);
  }
  invariant(!/[\r\n]/.test(value), "SHELL_VERIFICATION_UNSUPPORTED", "多行命令需要拆成独立验证声明。" );
  const tokens = [];
  let token = "";
  let quoted = null;
  let started = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (char === quoted) quoted = null;
      else if (char === "\\" && value[index + 1] === quoted) token += value[++index];
      else token += char;
    } else if (char === '"' || char === "'") {
      quoted = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      invariant(!/[;&|<>`]/.test(char) && !(char === "$" && value[index + 1] === "("), "SHELL_VERIFICATION_UNSUPPORTED", "验证命令不能包含 shell 操作符或展开；请提供 command/args JSON。" );
      token += char;
      started = true;
    }
  }
  invariant(!quoted, "INVALID_VERIFICATION_COMMAND", "验证命令存在未闭合引号。" );
  if (started) tokens.push(token);
  invariant(tokens[0]?.trim(), "INVALID_VERIFICATION_COMMAND", "验证命令缺少可执行文件。" );
  return { command: tokens[0], args: tokens.slice(1) };
}

export function commandKey(command, args) {
  const explicit = path.isAbsolute(command) || command.includes("/") || command.includes("\\");
  const normalize = (value) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
  const name = process.platform === "win32" ? command.toLowerCase() : command;
  const runtimeNode = (!explicit && (name === "node" || (process.platform === "win32" && name === "node.exe"))) ||
    (explicit && normalize(command) === normalize(process.execPath));
  return JSON.stringify([runtimeNode ? "runtime-node" : explicit ? `path:${normalize(command)}` : `bare:${name}`, args]);
}

export function compileChecks(verification) {
  invariant(Array.isArray(verification) && verification.length > 0, "VERIFICATION_REQUIRED", "任务至少需要一个可执行验证。" );
  return verification.map((value, index) => ({ id: `V${index + 1}`, ...parseCommand(value) }));
}

export function verificationKey(command, args, timeoutMs) {
  const key = commandKey(command, args);
  return timeoutMs === undefined ? key : JSON.stringify([key, timeoutMs]);
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
    throw error;
  }
}

export async function resolveCommandLaunch(command, args, { platform = process.platform, searchPath = process.env.PATH || process.env.Path || "" } = {}) {
  if (commandKey(command, []) === commandKey("node", [])) return { command: process.execPath, args: [...args] };
  const name = commandName(command);
  const entries = {
    npm: ["node_modules/npm/bin/npm-cli.js"],
    pnpm: ["node_modules/pnpm/bin/pnpm.cjs", "node_modules/corepack/dist/pnpm.js"],
    yarn: ["node_modules/yarn/bin/yarn.js", "node_modules/corepack/dist/yarn.js"],
  };
  if (platform !== "win32" || !entries[name]) return { command, args: [...args] };
  const directories = [...new Set(searchPath.split(platform === "win32" ? ";" : path.delimiter).filter(Boolean).concat(path.dirname(process.execPath)))];
  for (const directory of directories) {
    const native = path.join(directory, `${name}.exe`);
    if (!command.toLowerCase().endsWith(".cmd") && await isFile(native)) return { command: native, args: [...args] };
    if (!(await isFile(path.join(directory, `${name}.cmd`)))) continue;
    for (const relative of entries[name]) {
      const entry = path.join(directory, relative);
      if (await isFile(entry)) return { command: process.execPath, args: [entry, ...args] };
    }
    invariant(false, "PACKAGE_MANAGER_ENTRY_NOT_FOUND", `找到 ${name}.cmd，但未找到受支持的 Node CLI 入口。请配置明确的包管理器安装。`);
  }
  invariant(false, "PACKAGE_MANAGER_ENTRY_NOT_FOUND", `未找到 ${name} 的可执行入口。`);
}
