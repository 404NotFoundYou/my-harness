import { exists, readJson, resolveProjectPath } from "./filesystem.mjs";
import { parseCommand } from "./commands.mjs";
import { invariant } from "./errors.mjs";

const SPEC_KEYS = new Set(["schemaVersion", "id", "type", "title", "references", "acceptance", "nonGoals", "version", "authorizationMode", "authorizationSource", "flags", "bug", "risk", "approach", "databaseEvidence", "writeScopes", "verification", "docsImpact"]);

export function normalizeDocumentation(value) {
  if (typeof value !== "string") return value;
  const match = /^N\/A\s*(?:[:：]\s*(.*))?$/i.exec(value.trim());
  if (!match) return value;
  invariant(match[1]?.trim(), "DOCUMENTATION_REASON_REQUIRED", "N/A 必须附理由，例如 N/A: 无文档变化。" );
  return `N/A: ${match[1].trim()}`;
}

export async function loadBeginSpec(root, relative) {
  const spec = await readJson(await resolveProjectPath(root, relative, { mustExist: true }));
  invariant(spec && typeof spec === "object" && !Array.isArray(spec), "INVALID_BEGIN_SPEC", "任务定义必须是 JSON 对象。" );
  const unknown = Object.keys(spec).filter(key => !SPEC_KEYS.has(key));
  invariant(unknown.length === 0, "UNKNOWN_SPEC_FIELDS", "任务定义包含未知字段，未创建工作项。", { fields: unknown });
  invariant(spec.schemaVersion === 1, "INVALID_BEGIN_SPEC", "任务定义 schemaVersion 必须为 1。" );
  for (const key of ["id", "type", "title", "authorizationSource", "risk", "approach", "databaseEvidence"]) invariant(typeof spec[key] === "string" && spec[key].trim(), "INVALID_BEGIN_SPEC", `${key} 必须是非空字符串。`);
  for (const key of ["references", "acceptance", "writeScopes", "verification", "docsImpact"]) {
    invariant(Array.isArray(spec[key]) && spec[key].length > 0, "INVALID_BEGIN_SPEC", `${key} 必须是非空数组。`);
    if (key !== "verification") invariant(spec[key].every(value => typeof value === "string" && value.trim()), "INVALID_BEGIN_SPEC", `${key} 必须是字符串数组。`);
  }
  for (const key of ["nonGoals", "flags"]) if (spec[key] !== undefined) invariant(Array.isArray(spec[key]) && spec[key].every(value => typeof value === "string" && value.trim()), "INVALID_BEGIN_SPEC", `${key} 必须是非空字符串组成的数组。`);
  if (spec.bug != null) invariant(typeof spec.bug === "object" && !Array.isArray(spec.bug) && Object.keys(spec.bug).every(key => ["actual", "expected", "reproduction"].includes(key)) && ["actual", "expected", "reproduction"].every(key => typeof spec.bug[key] === "string" && spec.bug[key].trim()), "INVALID_BEGIN_SPEC", "bug 需要 actual、expected 和 reproduction 字符串。" );
  if (spec.version != null) invariant(typeof spec.version === "string", "INVALID_BEGIN_SPEC", "version 必须是字符串或 null。" );
  const { schemaVersion, ...options } = spec;
  if (Object.hasOwn(spec, "authorizationMode")) invariant(spec.authorizationMode === "autonomous", "AUTONOMOUS_AUTHORIZATION_REQUIRED", "begin --spec 仅用于已经获得自主执行授权的普通任务。" );
  options.authorizationMode ??= "autonomous";
  options.verification = spec.verification.map(value => {
    if (value && typeof value === "object") invariant(!Array.isArray(value) && Object.keys(value).every(key => ["command", "args", "acceptance"].includes(key)), "INVALID_BEGIN_SPEC", "检查对象只接受 command、args 和可选 acceptance。" );
    return JSON.stringify(parseCommand(value));
  });
  return options;
}

export async function diagnoseLegacyScopes(root, scopes) {
  for (const scope of scopes) {
    if (!scope.includes(",")) continue;
    const parts = scope.split(",").map(value => value.trim());
    if (parts.length < 2 || !parts.every(value => /[/\\]/.test(value) && /\.[A-Za-z0-9]+$/.test(value))) continue;
    const absolute = await resolveProjectPath(root, scope);
    if (await exists(absolute)) continue;
    invariant(false, "AMBIGUOUS_WRITE_SCOPE", "一个 --writes 看起来包含多个路径；请重复 --writes，或用 --spec 的 writeScopes 数组明确表达字面路径。未创建工作项。", { received: scope, suggestedScopes: parts });
  }
}
