import { createHash } from "node:crypto";
import { HarnessError } from "./errors.mjs";

const MARKER_PREFIX = "<!-- AI-HARNESS:";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function occurrences(value, token) {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(token, offset)) !== -1) {
    count += 1;
    offset += token.length;
  }
  return count;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineEnding(value) {
  return String(value).match(/\r\n|\n/)?.[0] || "\n";
}

function isLineStart(value, offset) {
  return offset === 0 || value[offset - 1] === "\n" || (offset === 1 && value[0] === "\uFEFF");
}

export function normalizeManagedBody(value) {
  return String(value)
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n+$/, "");
}

export function managedBodyHash(value) {
  return sha256(normalizeManagedBody(value));
}

export function renderManagedBlock({ relative, version, body, eol = "\n" }) {
  const normalized = normalizeManagedBody(body);
  const visibleBody = normalized.replace(/\n/g, eol);
  return [
    `<!-- AI-HARNESS:BEGIN file=${relative} version=${version} sha256=${sha256(normalized)} -->`,
    visibleBody,
    `<!-- AI-HARNESS:END file=${relative} -->`,
  ].join(eol);
}

export function inspectManagedBlock(content, relative) {
  const value = String(content);
  const beginPrefix = `<!-- AI-HARNESS:BEGIN file=${relative} `;
  const endMarker = `<!-- AI-HARNESS:END file=${relative} -->`;
  const beginCount = occurrences(value, beginPrefix);
  const endCount = occurrences(value, endMarker);
  const hasAnyHarnessMarker = value.includes(MARKER_PREFIX);

  if (beginCount === 0 && endCount === 0) {
    if (hasAnyHarnessMarker) {
      throw new HarnessError("MANAGED_BLOCK_MALFORMED", `${relative} 包含无法识别的 AI Harness 托管标记。`);
    }
    return { present: false };
  }
  if (beginCount !== 1 || endCount !== 1) {
    throw new HarnessError("MANAGED_BLOCK_MALFORMED", `${relative} 的托管标记必须且只能出现一组。`);
  }

  const start = value.indexOf(beginPrefix);
  const beginLineEnd = value.indexOf("\n", start);
  if (!isLineStart(value, start) || beginLineEnd === -1) {
    throw new HarnessError("MANAGED_BLOCK_MALFORMED", `${relative} 的 BEGIN 标记必须独占一行。`);
  }
  const beginLine = value.slice(start, beginLineEnd).replace(/\r$/, "");
  const beginPattern = new RegExp(
    `^<!-- AI-HARNESS:BEGIN file=${escapeRegExp(relative)} version=([A-Za-z0-9._-]+) sha256=([a-f0-9]{64}) -->$`,
  );
  const match = beginPattern.exec(beginLine);
  if (!match) throw new HarnessError("MANAGED_BLOCK_MALFORMED", `${relative} 的 BEGIN 标记格式无效。`);

  const endStart = value.indexOf(endMarker, beginLineEnd + 1);
  if (endStart === -1 || (endStart > 0 && value[endStart - 1] !== "\n")) {
    throw new HarnessError("MANAGED_BLOCK_MALFORMED", `${relative} 的 END 标记必须位于 BEGIN 之后并独占一行。`);
  }
  const afterEnd = endStart + endMarker.length;
  if (afterEnd < value.length && !["\r", "\n"].includes(value[afterEnd])) {
    throw new HarnessError("MANAGED_BLOCK_MALFORMED", `${relative} 的 END 标记必须独占一行。`);
  }

  let bodyEnd = endStart;
  if (value.slice(bodyEnd - 2, bodyEnd) === "\r\n") bodyEnd -= 2;
  else if (value[bodyEnd - 1] === "\n") bodyEnd -= 1;
  const body = value.slice(beginLineEnd + 1, bodyEnd);
  const actualHash = managedBodyHash(body);
  return {
    present: true,
    start,
    end: afterEnd,
    version: match[1],
    declaredHash: match[2],
    actualHash,
    hashValid: actualHash === match[2],
    body,
    eol: lineEnding(value),
  };
}

function hasImportLine(content, expectedImport) {
  return String(content)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => line.trim() === expectedImport);
}

export function mergeManagedFile({
  existing,
  relative,
  version,
  body,
  force = false,
  compatibleImport = null,
}) {
  const value = String(existing);
  const inspection = inspectManagedBlock(value, relative);
  if (!inspection.present && compatibleImport && hasImportLine(value, compatibleImport)) {
    return { action: "skip", content: value, managed: false, compatibleExisting: true };
  }

  const eol = lineEnding(value);
  const block = renderManagedBlock({ relative, version, body, eol });
  if (inspection.present) {
    if (!inspection.hashValid && !force) {
      throw new HarnessError("MANAGED_BLOCK_MODIFIED", `${relative} 的 Harness 托管内容已被修改；默认拒绝覆盖。`, {
        declaredHash: inspection.declaredHash,
        actualHash: inspection.actualHash,
      });
    }
    const content = `${value.slice(0, inspection.start)}${block}${value.slice(inspection.end)}`;
    return {
      action: content === value ? "skip" : inspection.hashValid ? "update-managed" : "repair-managed",
      content,
      managed: true,
      compatibleExisting: false,
    };
  }

  if (normalizeManagedBody(value) === normalizeManagedBody(body)) {
    return { action: "adopt-managed", content: `${block}${eol}`, managed: true, compatibleExisting: false };
  }
  if (!value) return { action: "create", content: `${block}${eol}`, managed: true, compatibleExisting: false };
  const separator = value.endsWith("\n") ? eol : `${eol}${eol}`;
  return {
    action: "merge",
    content: `${value}${separator}${block}${eol}`,
    managed: true,
    compatibleExisting: false,
  };
}
