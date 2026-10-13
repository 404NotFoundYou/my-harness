import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.mjs";
import { importRows } from "../src/caller.mjs";

test("non-string input must fail rather than be coerced", () => {
  for (const input of [undefined, null, 0, true, {}, [], new String("a"), Symbol("a"), 1n]) {
    assert.throws(() => parseCsv(input), TypeError);
  }
});

test("empty input contains no records, including a lone initial BOM", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("\uFEFF"), []);
});

test("remove exactly one initial BOM without losing BOM data elsewhere", () => {
  assert.deepEqual(parseCsv('\uFEFF"a",b'), [["a", "b"]]);
  assert.deepEqual(parseCsv("\uFEFF\uFEFFa,\uFEFFb\n\uFEFF"), [["\uFEFFa", "\uFEFFb"], ["\uFEFF"]]);
  assert.deepEqual(parseCsv('"\uFEFF"'), [["\uFEFF"]]);
});

test("empty fields retain their positions and record widths", () => {
  for (const [input, expected] of [
    [",", [["", ""]]],
    [",,", [["", "", ""]]],
    [",a,,", [["", "a", "", ""]]],
    ['"",,""', [["", "", ""]]],
    ["a\n,", [["a"], ["", ""]]],
  ]) assert.deepEqual(parseCsv(input), expected);
});

for (const separator of ["\r\n", "\n", "\r"]) {
  test(`record separator ${JSON.stringify(separator)} preserves blank rows but adds no trailing phantom row`, () => {
    assert.deepEqual(parseCsv(separator), [[""]]);
    assert.deepEqual(parseCsv(separator + separator), [[""], [""]]);
    assert.deepEqual(parseCsv(`a,b${separator}${separator}c,${separator}`), [["a", "b"], [""], ["c", ""]]);
    assert.deepEqual(parseCsv(`""${separator}`), [[""]]);
  });
}

test("mixed record endings are accepted without normalizing quoted newlines", () => {
  assert.deepEqual(parseCsv('a\r\nb\nc\rd'), [["a"], ["b"], ["c"], ["d"]]);
  assert.deepEqual(parseCsv('"a\r\nb\nc\rd",x\r\n"e\n",y\r'), [["a\r\nb\nc\rd", "x"], ["e\n", "y"]]);
});

test("quoted commas and doubled quotes remain field data", () => {
  assert.deepEqual(parseCsv('"a,b","say ""hi""",""""'), [["a,b", 'say "hi"', '"']]);
  assert.deepEqual(parseCsv('"""",x'), [['"', "x"]]);
});

test("all whitespace and Unicode data are preserved verbatim", () => {
  assert.deepEqual(parseCsv(' a ,\t中🙂 ," b\t "'), [[" a ", "\t中🙂 ", " b\t "]]);
  assert.deepEqual(parseCsv(" \t"), [[" \t"]]);
});

test("unterminated quoted fields cannot silently import partial data", () => {
  for (const input of ['"', '"abc', '"a""', 'x,"a\r\nb', 'ok\n"bad']) {
    assert.throws(() => parseCsv(input), SyntaxError, JSON.stringify(input));
  }
});

test("quotes must begin at the exact field start, not after data or whitespace", () => {
  for (const input of ['a"b', ' "a"', '\t"a"', 'a,b"', '\uFEFF\uFEFF"a"']) {
    assert.throws(() => parseCsv(input), SyntaxError, JSON.stringify(input));
  }
});

test("closed quoted fields reject trailing data including whitespace", () => {
  for (const input of ['"a"b', '"a" ', '"a"\t', '"a"\uFEFF', '""x', 'x\n"a" b']) {
    assert.throws(() => parseCsv(input), SyntaxError, JSON.stringify(input));
  }
});

test("caller retains field arrays and widths, and propagates invalid input", () => {
  assert.deepEqual(importRows('"a,b",\r\n\n""'), [
    { fields: ["a,b", ""], width: 2 },
    { fields: [""], width: 1 },
    { fields: [""], width: 1 },
  ]);
  assert.deepEqual(importRows(""), []);
  assert.throws(() => importRows('"bad'), SyntaxError);
  assert.throws(() => importRows(null), TypeError);
});
