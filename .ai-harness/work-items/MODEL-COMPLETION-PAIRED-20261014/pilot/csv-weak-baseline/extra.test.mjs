import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.mjs";
import { importRows } from "../src/caller.mjs";

test("reject non-string inputs rather than silently coercing imported data", () => {
  for (const value of [undefined, null, 0, true, [], {}, new String("a"), Symbol("a"), 1n]) {
    assert.throws(() => parseCsv(value), TypeError);
  }
});

test("strip exactly one leading BOM without losing embedded data", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\uFEFF"), []);
  assert.deepEqual(parseCsv("\uFEFFa,b"), [["a", "b"]]);
  assert.deepEqual(parseCsv("\uFEFF\uFEFF"), [["\uFEFF"]]);
  assert.deepEqual(parseCsv("a,\uFEFFb"), [["a", "\uFEFFb"]]);
  assert.deepEqual(parseCsv('\uFEFF"a"'), [["a"]]);
  assert.deepEqual(parseCsv('"\uFEFF"'), [["\uFEFF"]]);
});

test("preserve empty records but do not invent one after a final separator", () => {
  for (const separator of ["\r\n", "\n", "\r"]) {
    assert.deepEqual(parseCsv(separator), [[""]]);
    assert.deepEqual(parseCsv(separator + separator), [[""], [""]]);
    assert.deepEqual(parseCsv("a" + separator), [["a"]]);
    assert.deepEqual(parseCsv("a" + separator + separator), [["a"], [""]]);
    assert.deepEqual(parseCsv("," + separator), [["", ""]]);
    assert.deepEqual(parseCsv(separator + ","), [[""], ["", ""]]);
    assert.deepEqual(parseCsv('""' + separator), [[""]]);
  }
  assert.deepEqual(parseCsv("a\r\nb\nc\rd"), [["a"], ["b"], ["c"], ["d"]]);
});

test("preserve field positions and whitespace for downstream column mapping", () => {
  assert.deepEqual(parseCsv(","), [["", ""]]);
  assert.deepEqual(parseCsv(",,x,,"), [["", "", "x", "", ""]]);
  assert.deepEqual(parseCsv(" a ,\t, "), [[" a ", "\t", " "]]);
  assert.deepEqual(parseCsv('"",'), [["", ""]]);
  assert.deepEqual(parseCsv(',""'), [["", ""]]);
});

test("quoted fields retain delimiters and original line endings as data", () => {
  assert.deepEqual(parseCsv('"a,b","a\r\nb\nc\rd"'), [["a,b", "a\r\nb\nc\rd"]]);
  assert.deepEqual(parseCsv('"a""b","""",z'), [['a"b', '"', "z"]]);
  assert.deepEqual(parseCsv('""'), [[""]]);
  assert.deepEqual(parseCsv('" a "'), [[" a "]]);
  assert.deepEqual(parseCsv('"a"\r\n"b"\rc'), [["a"], ["b"], ["c"]]);
});

test("reject malformed quoting instead of accepting corrupted column boundaries", () => {
  for (const input of ['"', '"a', '"a""', '"""', 'a"b', ' "a"', '\t"a"', '"a"x', '"a" ', '"a"\t', 'ok\n"bad', 'a,"b"x']) {
    assert.throws(() => parseCsv(input), SyntaxError, JSON.stringify(input));
  }
});

test("caller keeps field widths and values for both empty and quoted imports", () => {
  assert.deepEqual(importRows(""), []);
  assert.deepEqual(importRows('"a,b",\r\n\r\nx'), [
    { fields: ["a,b", ""], width: 2 },
    { fields: [""], width: 1 },
    { fields: ["x"], width: 1 },
  ]);
  assert.throws(() => importRows('"bad'), SyntaxError);
});
