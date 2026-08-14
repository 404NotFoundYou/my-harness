import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectManagedBlock,
  managedBodyHash,
  mergeManagedFile,
  normalizeManagedBody,
  renderManagedBlock,
} from "../src/managed-block.mjs";

const relative = "AGENTS.md";
const body = "# Runtime rules\n\n- Use the checked-out code as evidence.\n";

test("managed blocks round-trip LF, CRLF and a file BOM", () => {
  for (const eol of ["\n", "\r\n"]) {
    const rendered = renderManagedBlock({ relative, version: "1.0.0", body, eol });
    const content = `\uFEFF${rendered}${eol}`;
    const inspected = inspectManagedBlock(content, relative);
    assert.equal(inspected.present, true);
    assert.equal(inspected.start, 1);
    assert.equal(inspected.version, "1.0.0");
    assert.equal(inspected.hashValid, true);
    assert.equal(inspected.actualHash, managedBodyHash(body));
    assert.equal(inspected.eol, eol);
    assert.equal(normalizeManagedBody(inspected.body), normalizeManagedBody(body));
  }
});

test("merge preserves custom bytes outside the managed block", () => {
  const existing = "\uFEFF# Project rules\r\n\r\n- Preserve this exact text.";
  const merged = mergeManagedFile({ existing, relative, version: "1.0.0", body });
  assert.equal(merged.action, "merge");
  assert.ok(merged.content.startsWith(`${existing}\r\n\r\n`));
  assert.equal(inspectManagedBlock(merged.content, relative).hashValid, true);
});

test("a compatible adapter import is accepted without rewriting", () => {
  const existing = "# Claude rules\n\n@AGENTS.md\n";
  const merged = mergeManagedFile({
    existing,
    relative: "CLAUDE.md",
    version: "1.0.0",
    body: "@AGENTS.md\n",
    compatibleImport: "@AGENTS.md",
  });
  assert.deepEqual(merged, {
    action: "skip",
    content: existing,
    managed: false,
    compatibleExisting: true,
  });
});

test("a valid older block upgrades while a modified block requires force", () => {
  const oldBlock = `${renderManagedBlock({ relative, version: "0.9.0", body: "old body\n" })}\n`;
  const upgraded = mergeManagedFile({ existing: oldBlock, relative, version: "1.0.0", body });
  assert.equal(upgraded.action, "update-managed");
  assert.equal(inspectManagedBlock(upgraded.content, relative).version, "1.0.0");

  const tampered = oldBlock.replace("old body", "changed body");
  assert.throws(
    () => mergeManagedFile({ existing: tampered, relative, version: "1.0.0", body }),
    { code: "MANAGED_BLOCK_MODIFIED" },
  );
  const repaired = mergeManagedFile({ existing: tampered, relative, version: "1.0.0", body, force: true });
  assert.equal(repaired.action, "repair-managed");
  assert.equal(inspectManagedBlock(repaired.content, relative).hashValid, true);
});

test("partial, duplicate and inline markers are rejected as malformed", () => {
  const valid = renderManagedBlock({ relative, version: "1.0.0", body });
  for (const malformed of [
    valid.replace(`<!-- AI-HARNESS:END file=${relative} -->`, ""),
    `${valid}\n${valid}`,
    `prefix ${valid}`,
    valid.replace(`<!-- AI-HARNESS:END file=${relative} -->`, `<!-- AI-HARNESS:END file=${relative} --> suffix`),
  ]) {
    assert.throws(() => inspectManagedBlock(malformed, relative), { code: "MANAGED_BLOCK_MALFORMED" });
  }
});
