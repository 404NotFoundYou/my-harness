import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.mjs";
import { importRows } from "../src/caller.mjs";

test("reject nonstrings rather than implicitly converting imported data", () => {
  for (const value of [undefined, null, 0, true, {}, [], new String("a"), Symbol("a")]) {
    assert.throws(() => parseCsv(value), TypeError);
  }
});

test("remove exactly one leading BOM without stripping field contents", () => {
  for (const [input, expected] of [
    ["", []], ["\uFEFF", []], ["\uFEFFa,b", [["a", "b"]]],
    ["\uFEFF\uFEFF", [["\uFEFF"]]], ["a\uFEFF,\uFEFF", [["a\uFEFF", "\uFEFF"]]],
    ['\uFEFF"a"', [["a"]]], ['"\uFEFF"', [["\uFEFF"]]],
  ]) assert.deepEqual(parseCsv(input), expected);
});

test("preserve empty records but do not invent one after the final separator", () => {
  for (const sep of ["\r\n", "\n", "\r"]) {
    assert.deepEqual(parseCsv(sep), [[""]]);
    assert.deepEqual(parseCsv(sep + sep), [[""], [""]]);
    assert.deepEqual(parseCsv("a,," + sep), [["a", "", ""]]);
    assert.deepEqual(parseCsv("a" + sep + sep + "b" + sep), [["a"], [""], ["b"]]);
    assert.deepEqual(parseCsv('""' + sep), [[""]]);
  }
  assert.deepEqual(parseCsv("a\r\nb\nc\rd"), [["a"], ["b"], ["c"], ["d"]]);
  assert.deepEqual(parseCsv(","), [["", ""]]);
  assert.deepEqual(parseCsv(",,\n,"), [["", "", ""], ["", ""]]);
});

test("quoted fields retain delimiters, original newlines, spaces and escaped quotes", () => {
  assert.deepEqual(parseCsv('"a,b","x\r\ny\nz\rw","say ""hi""",'),
    [["a,b", "x\r\ny\nz\rw", 'say "hi"', ""]]);
  assert.deepEqual(parseCsv('"",  a\t ," b "'), [["", "  a\t ", " b "]]);
  assert.deepEqual(parseCsv('""""'), [['"']]);
  assert.deepEqual(parseCsv('"a",b\n"c",d'), [["a", "b"], ["c", "d"]]);
});

test("reject malformed quoting to avoid silently importing corrupted fields", () => {
  for (const input of ['"', '"a', '"a""', '"""', 'a"b', ' "a"',
    '"a" ', '"a"x', '"a"\t', '"a""b', 'ok\n"bad', 'a,"b"x']) {
    assert.throws(() => parseCsv(input), SyntaxError, JSON.stringify(input));
  }
});

test("caller keeps its fields and width contract for parsed CSV records", () => {
  assert.deepEqual(importRows('"a,b",\r\n\r\nx'), [
    { fields: ["a,b", ""], width: 2 },
    { fields: [""], width: 1 },
    { fields: ["x"], width: 1 },
  ]);
  assert.deepEqual(importRows(""), []);
  assert.throws(() => importRows('"bad'), SyntaxError);
});
