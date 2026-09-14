import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.mjs";
import { importRows } from "../src/caller.mjs";

test("handles BOM, empty input, empty records, and record separators", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\uFEFF"), []);
  assert.deepEqual(parseCsv("\uFEFF\uFEFFa"), [["\uFEFFa"]]);
  assert.deepEqual(parseCsv("\n\r\n\r"), [[""], [""], [""]]);
});

test("parses quoted fields without normalizing their contents", () => {
  assert.deepEqual(parseCsv('"a,b","a""b","x\r\ny\nz\r"'), [["a,b", 'a"b', "x\r\ny\nz\r"]]);
  assert.deepEqual(parseCsv('"",'), [["", ""]]);
});

test("rejects invalid input and invalid quote placement", () => {
  assert.throws(() => parseCsv(null), TypeError);
  assert.throws(() => parseCsv('"open'), SyntaxError);
  assert.throws(() => parseCsv('a"b'), SyntaxError);
  assert.throws(() => parseCsv('"a" b'), SyntaxError);
});

test("keeps the caller row shape compatible", () => {
  assert.deepEqual(importRows('"a,b",c\r\n'), [{ fields: ["a,b", "c"], width: 2 }]);
});
