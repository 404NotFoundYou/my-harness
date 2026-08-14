import path from "node:path";

const DEFAULT_DENY_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "cscript",
  "dd",
  "del",
  "diskpart",
  "erase",
  "format",
  "mkfs",
  "powershell",
  "pwsh",
  "rm",
  "rmdir",
  "sdelete",
  "sh",
  "shutdown",
  "wscript",
]);

const DEFAULT_ALLOW_EXECUTABLES = new Set([
  "cargo",
  "cmake",
  "ctest",
  "dart",
  "dotnet",
  "eslint",
  "flutter",
  "go",
  "gradle",
  "gradlew",
  "java",
  "javac",
  "make",
  "node",
  "npm",
  "pnpm",
  "prettier",
  "pytest",
  "python",
  "python3",
  "rustc",
  "swift",
  "tsc",
  "xcodebuild",
  "yarn",
]);

const DENY_TEXT_PATTERNS = [
  /\bremove-item\b/i,
  /\bclear-content\b/i,
  /\bformat-volume\b/i,
  /\bstop-computer\b/i,
  /\breset-computermachinepassword\b/i,
  /(?:^|\s)git\s+reset\s+--hard(?:\s|$)/i,
  /(?:^|\s)git\s+clean\s+-[^\s]*f/i,
  /(?:^|\s)git\s+checkout\s+--(?:\s|$)/i,
  /(?:^|\s)git\s+push\b[^\n]*--force(?:-with-lease)?/i,
  /(?:^|\s)git\s+branch\s+-D(?:\s|$)/i,
  /(?:^|\s)git\s+worktree\s+remove(?:\s|$)/i,
  /(?:^|\s)terraform\s+destroy(?:\s|$)/i,
  /(?:^|\s)kubectl\s+delete(?:\s|$)/i,
];

const ASK_TEXT_PATTERNS = [
  /\b(deploy|publish|release)\b/i,
  /(?:^|\s)git\s+(add|commit|merge|rebase|push|tag)(?:\s|$)/i,
  /(?:^|\s)(npm|pnpm|yarn)\s+(install|add|remove|update|upgrade|publish)(?:\s|$)/i,
  /(?:^|\s)(pip|pip3)\s+install(?:\s|$)/i,
  /(?:^|\s)cargo\s+(install|publish)(?:\s|$)/i,
  /(?:^|\s)go\s+install(?:\s|$)/i,
  /(?:^|\s)terraform\s+apply(?:\s|$)/i,
  /(?:^|\s)kubectl\s+(apply|replace|patch)(?:\s|$)/i,
  /(?:^|\s)docker\s+push(?:\s|$)/i,
  /(?:^|\s)gh\s+pr\s+merge(?:\s|$)/i,
];

function executableName(command) {
  const base = path.basename(command || "").toLowerCase();
  return base.replace(/\.(exe|cmd|bat)$/i, "");
}

function commandText(command, args) {
  return [command, ...args].join(" ");
}

function usesExplicitPath(command) {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

function includesAny(set, values) {
  return values.some((value) => set.has(value));
}

function allowKnownSubcommand(executable, args) {
  const normalizedArgs = args.map((arg) => arg.toLowerCase());
  if (normalizedArgs.some((arg) => ["--version", "-v", "version"].includes(arg))) return true;
  if (executable === "node") {
    if (includesAny(new Set(normalizedArgs), ["-e", "--eval", "-p", "--print", "--interactive"])) return false;
    return normalizedArgs[0] === "--test" || normalizedArgs[0] === "--check" || normalizedArgs[0]?.includes(".ai-harness/bin/harness.mjs") || normalizedArgs[0]?.includes(".ai-harness/tests/run.mjs");
  }
  if (["npm", "pnpm", "yarn"].includes(executable)) {
    if (normalizedArgs[0] === "test") return true;
    if (normalizedArgs[0] === "run") {
      return /^(test|lint|check|typecheck|build|format(?::check)?|verify)(:|$)/.test(normalizedArgs[1] || "");
    }
    return false;
  }
  if (executable === "cargo") return ["test", "check", "clippy", "fmt", "build"].includes(normalizedArgs[0]);
  if (executable === "go") return ["test", "vet", "build", "fmt"].includes(normalizedArgs[0]);
  if (executable === "dotnet") return ["test", "build", "format"].includes(normalizedArgs[0]);
  if (executable === "flutter") return ["test", "analyze", "build"].includes(normalizedArgs[0]);
  if (executable === "dart") return ["test", "analyze", "format", "compile"].includes(normalizedArgs[0]);
  if (["gradle", "gradlew"].includes(executable)) {
    return normalizedArgs.some((arg) => /(^|:)(test|check|build|lint|assemble)/.test(arg));
  }
  if (["python", "python3"].includes(executable)) return normalizedArgs[0] === "-m" && ["pytest", "unittest", "compileall"].includes(normalizedArgs[1]);
  if (executable === "pytest") return true;
  return true;
}

export function classifyCommand(command, args = [], config = {}) {
  if (typeof command !== "string" || !command.trim() || !Array.isArray(args)) {
    return { decision: "deny", rule: "parse-failure", reason: "命令或参数结构无效。" };
  }
  const executable = executableName(command);
  const deny = new Set([...DEFAULT_DENY_EXECUTABLES, ...(config.additionalDenyExecutables || []).map((item) => item.toLowerCase())]);
  const ask = new Set((config.additionalAskExecutables || []).map((item) => item.toLowerCase()));
  const allow = new Set([...DEFAULT_ALLOW_EXECUTABLES, ...(config.additionalAllowExecutables || []).map((item) => item.toLowerCase())]);
  const text = commandText(command, args);

  if (deny.has(executable)) {
    return { decision: "deny", rule: "deny-executable", reason: `禁止通过 Harness 执行 ${executable}。` };
  }
  if (usesExplicitPath(command) && path.resolve(command) !== path.resolve(process.execPath)) {
    return { decision: "ask", rule: "explicit-executable-path", reason: "显式可执行文件路径需要外部确认，避免同名程序伪装。" };
  }
  const deniedPattern = DENY_TEXT_PATTERNS.find((pattern) => pattern.test(text));
  if (deniedPattern) {
    return { decision: "deny", rule: "deny-structure", reason: "命令匹配不可逆或破坏性结构。" };
  }
  const askPattern = ASK_TEXT_PATTERNS.find((pattern) => pattern.test(text));
  if (ask.has(executable) || askPattern) {
    return { decision: "ask", rule: "external-approval", reason: "命令会修改依赖、Git、部署或外部状态，需要在 Harness 外取得明确授权。" };
  }
  if (!allow.has(executable)) {
    return { decision: "ask", rule: "unknown-executable", reason: `未知可执行文件 ${executable}，默认不执行。` };
  }
  if (!allowKnownSubcommand(executable, args)) {
    return { decision: "ask", rule: "unknown-subcommand", reason: `${executable} 子命令不在验证型允许范围内。` };
  }
  return { decision: "allow", rule: "verified-command", reason: "命令属于允许的构建、检查或测试范围。" };
}
