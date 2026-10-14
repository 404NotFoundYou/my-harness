import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/csv.mjs";
import { importRows } from "../src/caller.mjs";

test("拒绝非字符串而非隐式转换导入数据", () => {
  for (const value of [undefined, null, 0, true, {}, [], new String("a"), Symbol("a")]) {
    assert.throws(() => parseCsv(value), TypeError);
  }
});

test("只去掉一个起始BOM，保留字段中的BOM及所有空白", () => {
  for (const value of ["", "\uFEFF"]) assert.deepEqual(parseCsv(value), []);
  assert.deepEqual(parseCsv("\uFEFF\uFEFFa, b\t ,\uFEFF"), [["\uFEFFa", " b\t ", "\uFEFF"]]);
  assert.deepEqual(parseCsv('"\uFEFF"'), [["\uFEFF"]]);
  assert.deepEqual(parseCsv("  "), [["  "]]);
});

test("保留空字段和真实空行，但不凭末尾分隔符制造额外记录", () => {
  for (const newline of ["\r\n", "\n", "\r"]) {
    assert.deepEqual(parseCsv(newline), [[""]]);
    assert.deepEqual(parseCsv(newline + newline), [[""], [""]]);
    assert.deepEqual(parseCsv("a,," + newline), [["a", "", ""]]);
    assert.deepEqual(parseCsv("a" + newline + newline + "b"), [["a"], [""], ["b"]]);
    assert.deepEqual(parseCsv('""' + newline), [[""]]);
  }
  assert.deepEqual(parseCsv(","), [["", ""]]);
  assert.deepEqual(parseCsv("a\r\nb\nc\rd"), [["a"], ["b"], ["c"], ["d"]]);
});

test("引号保护逗号和原始换行，转义双引号只解码一次", () => {
  assert.deepEqual(parseCsv('"a,b","x\r\ny\nz\rw","a""b",'), [["a,b", "x\r\ny\nz\rw", 'a"b', ""]]);
  assert.deepEqual(parseCsv('""'), [[""]]);
  assert.deepEqual(parseCsv('""""'), [['"']]);
  assert.deepEqual(parseCsv('"a",b'), [["a", "b"]]);
});

test("严格拒绝损坏的引号语法，防止静默导入错误数据", () => {
  for (const value of ['"', '"a', '"""', 'a"', 'a"b', ' "a"', '"a" ', '"a"x', '"a"\t', 'x,\n"b']) {
    assert.throws(() => parseCsv(value), SyntaxError, JSON.stringify(value));
  }
});

test("调用方仍获得二维字段及正确宽度，并传播语法错误", () => {
  assert.deepEqual(importRows('"a,b",\r\n\r\nx'), [
    { fields: ["a,b", ""], width: 2 },
    { fields: [""], width: 1 },
    { fields: ["x"], width: 1 },
  ]);
  assert.deepEqual(importRows(""), []);
  assert.throws(() => importRows('a"'), SyntaxError);
});
