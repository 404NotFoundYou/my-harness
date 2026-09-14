import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.mjs";

test("parses quoted fields, escaped quotes, and embedded line breaks", () => {
  assert.deepEqual(parseCsv('a,"b,c"\r\n"d""e","f\r\ng"'), [
    ["a", "b,c"],
    ['d"e', "f\r\ng"]
  ]);
});

test("preserves empty rows and does not create a row after a trailing separator", () => {
  assert.deepEqual(parseCsv("a\n\n"), [["a"], [""]]);
  assert.deepEqual(parseCsv("\n"), [[""]]);
  assert.deepEqual(parseCsv("a,b\n"), [["a", "b"]]);
});

test("removes only one leading BOM and rejects malformed CSV", () => {
  assert.deepEqual(parseCsv("\ufeffa,b"), [["a", "b"]]);
  assert.deepEqual(parseCsv("\ufeff\ufeffa"), [["\ufeffa"]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\ufeff"), []);
  assert.throws(() => parseCsv(1), TypeError);
  assert.throws(() => parseCsv('"a'), SyntaxError);
  assert.throws(() => parseCsv('a"b'), SyntaxError);
  assert.throws(() => parseCsv('"a"x'), SyntaxError);
});
