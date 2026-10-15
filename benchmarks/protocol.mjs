import { redact } from "../.ai-harness/src/evidence.mjs";

export const responseSchema = { type: "object", properties: { completed: { type: "boolean" }, summary: { type: "string" }, tests: { type: "array", items: { type: "string" } } }, required: ["completed", "summary", "tests"], additionalProperties: false };

export function redactProtocolValue(value) {
  if (typeof value === "string") {
    const candidate = value.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
    if (/^[{\[]/.test(candidate)) {
      try { return JSON.stringify(redactProtocolValue(JSON.parse(candidate))); } catch {}
    }
    return redact(value);
  }
  if (Array.isArray(value)) return value.map(redactProtocolValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:authorization|(?:api|access|refresh|id|auth)[_-]?token|token|secret|password|api[_-]?key|private[_-]?key)$/i.test(key) ? "[REDACTED]" : redactProtocolValue(entry)]));
  return value;
}

export function inspectFinal(text) {
  try {
    const value = redactProtocolValue(typeof text === "string" ? JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")) : text);
    const final = value && !Array.isArray(value) && Object.keys(value).every(key => ["completed", "summary", "tests"].includes(key)) &&
      typeof value.completed === "boolean" && typeof value.summary === "string" && Array.isArray(value.tests) && value.tests.every(entry => typeof entry === "string") ? value : null;
    return {status:final ? "valid" : "invalid-schema",final};
  } catch { return {status:"invalid-json",final:null}; }
}

export function parseFinal(text) { return inspectFinal(text).final; }

export function validFinalOutput(value) {
  if (!value || Array.isArray(value) || value.version !== 1 || Object.keys(value).length !== 5) return false;
  if (["valid", "invalid-json", "invalid-schema"].includes(value.status)) return value.exists === true && Number.isSafeInteger(value.bytes) && value.bytes >= (value.status === "valid" ? 1 : 0) && value.errorCode === null;
  if (value.status === "missing") return value.exists === false && value.bytes === null && value.errorCode === "ENOENT";
  return value.status === "unreadable" && value.exists === null && value.bytes === null && (value.errorCode === null || typeof value.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode));
}

export function completedRun(result, final) {
  return result.exitCode === 0 && !result.timedOut && !result.toolLimit && !result.error &&
    result.unparsedLines === 0 && result.protocolSuccess === true && Array.isArray(result.errors) && result.errors.length === 0 && parseFinal(final)?.completed === true;
}
