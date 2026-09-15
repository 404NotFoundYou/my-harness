import { invariant } from "./errors.mjs";

export function policyFilesFor(index, type, flags = [], { version = 2, databaseImpact = "unknown" } = {}) {
  invariant(Object.hasOwn(index.byType, type), "INVALID_WORK_TYPE", `未知工作类型：${type}`);
  invariant(["unknown", "none", "required"].includes(databaseImpact), "INVALID_DATABASE_IMPACT", "数据库影响必须是 unknown、none 或 required。" );
  const names = new Set([...(index.always || []), ...index.byType[type]]);
  for (const flag of flags) {
    invariant(Object.hasOwn(index.byFlag, flag), "INVALID_POLICY_FLAG", `未知策略标志：${flag}`);
    for (const name of index.byFlag[flag]) names.add(name);
  }
  if (version >= 2) {
    if (databaseImpact === "none" && !flags.includes("database")) names.delete("database.md");
    if (databaseImpact === "required") names.add("database.md");
  }
  return [...names].map(name => `.ai-harness/policies/${name}`);
}

export function itemPolicyFiles(index, item) {
  return policyFilesFor(index, item.type, item.flags, { version: item.policyRoutingVersion || 1, databaseImpact: item.database.impact });
}
