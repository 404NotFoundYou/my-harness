import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.mjs";
import { importRows } from "../src/caller.mjs";

test("CSV preserves records, empty fields, and all supported line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\nc,d\re,f\n"), [["a", "b"], ["c", "d"], ["e", "f"]]);
  assert.deepEqual(parseCsv("\n\n"), [[""], [""]]);
  assert.deepEqual(parseCsv("a,,"), [["a", "", ""]]);
});

test("CSV removes only one leading BOM and preserves quoted content", () => {
  assert.deepEqual(parseCsv("\uFEFF\"a,b\r\nc\",\"say \"\"hi\"\"\""), [["a,b\r\nc", "say \"hi\""]]);
  assert.deepEqual(parseCsv("\uFEFF\uFEFFx"), [["\uFEFFx"]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\uFEFF"), []);
});

test("CSV rejects non-string input and malformed quotes", () => {
  assert.throws(() => parseCsv(null), TypeError);
  for (const value of ["a\"b", "\"a\"b", "\"a", "\"a\"x"]) {
    assert.throws(() => parseCsv(value), SyntaxError);
  }
});

test("caller compatibility retains fields and width", () => {
  assert.deepEqual(importRows("a,\"b,c\""), [{ fields: ["a", "b,c"], width: 2 }]);
});
