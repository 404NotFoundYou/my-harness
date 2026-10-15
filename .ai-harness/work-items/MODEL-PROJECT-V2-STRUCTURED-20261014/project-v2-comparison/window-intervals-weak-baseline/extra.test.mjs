import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.mjs";
import { clipWindow } from "../src/window.mjs";
import { getCoverage } from "../src/caller.mjs";

// 修复前实测：node --test test/public.test.mjs，2 项中 1 项失败。
// overlaps must be merged after clipping：实际 spans=[{start:0,end:3},
// {start:2,end:7}], covered=8；期望 spans=[{start:1,end:5}], covered=4。
// 根因：mergeIntervals 原地排序、复用记录且未归并；clipWindow 只筛选未裁剪。
// 补充测试修复前实测：node --test test/extra.test.mjs，6 项全部失败。
// 冻结输入触发 TypeError；空数组返回原引用；重复区间导致重复计数。
// 修复后实测：node --test test/public.test.mjs test/extra.test.mjs，8 项通过、0 失败、0 跳过。
// 独立单位集合核验覆盖 15 × 15 × 15 = 3375 组区间与窗口组合。
// 回归意图：并集不重复计数，窗口外长度不计入，调用方拥有的输入不被修改。

test("merge preserves caller-owned input and returns independent records", () => {
  const input = Object.freeze([
    Object.freeze({ start: 8, end: 10 }),
    Object.freeze({ start: 1, end: 3 }),
  ]);
  const result = mergeIntervals(input);
  assert.deepEqual(result, [{ start: 1, end: 3 }, { start: 8, end: 10 }]);
  assert.notStrictEqual(result, input);
  for (const row of result) assert.ok(!input.includes(row));
  result[0].start = 0;
  assert.deepEqual(input, [{ start: 8, end: 10 }, { start: 1, end: 3 }]);
});

test("nested, duplicate and touching spans form one union without losing the longest end", () => {
  const input = [
    { start: 8, end: 10 }, { start: 1, end: 9 },
    { start: 1, end: 3 }, { start: 3, end: 5 },
    { start: 1, end: 9 }, { start: 10, end: 12 },
    { start: 15, end: 16 },
  ];
  const before = structuredClone(input);
  assert.deepEqual(mergeIntervals(input), [{ start: 1, end: 12 }, { start: 15, end: 16 }]);
  assert.deepEqual(input, before);
});

test("clipping excludes touching-only spans and trims both window boundaries", () => {
  const input = Object.freeze([
    Object.freeze({ start: 7, end: 12 }),
    Object.freeze({ start: 0, end: 2 }),
    Object.freeze({ start: 10, end: 14 }),
    Object.freeze({ start: 1, end: 4 }),
  ]);
  const window = Object.freeze({ start: 2, end: 10 });
  const result = clipWindow(input, window);
  assert.deepEqual(result, [{ start: 2, end: 4 }, { start: 7, end: 10 }]);
  for (const row of result) assert.ok(!input.includes(row));
  assert.deepEqual(window, { start: 2, end: 10 });
  assert.deepEqual(getCoverage(input, window), { spans: result, covered: 5 });
});

test("empty inputs and disjoint windows have zero coverage and fresh arrays", () => {
  const input = Object.freeze([]);
  assert.deepEqual(mergeIntervals(input), []);
  assert.notStrictEqual(mergeIntervals(input), input);
  assert.deepEqual(getCoverage(input, { start: 0, end: 1000000 }), { spans: [], covered: 0 });
  assert.deepEqual(clipWindow([{ start: 0, end: 2 }], { start: 3, end: 5 }), []);
});

test("full-range duplicates count each covered unit only once", () => {
  assert.deepEqual(getCoverage([
    { start: 0, end: 1000000 }, { start: 0, end: 1000000 },
    { start: 2, end: 999999 },
  ], { start: 1, end: 1000000 }), {
    spans: [{ start: 1, end: 1000000 }], covered: 999999,
  });
});

test("coverage agrees with an independent unit-set oracle for all small interval pairs", () => {
  const rows = [];
  for (let start = 0; start < 5; start++) {
    for (let end = start + 1; end <= 5; end++) rows.push({ start, end });
  }
  for (const a of rows) for (const b of rows) for (const window of rows) {
    const input = [a, b];
    const before = structuredClone(input);
    const units = [];
    for (let x = window.start; x < window.end; x++) {
      if (input.some(row => row.start <= x && x < row.end)) units.push(x);
    }
    const expected = [];
    for (const x of units) {
      const last = expected[expected.length - 1];
      if (last && last.end === x) last.end = x + 1;
      else expected.push({ start: x, end: x + 1 });
    }
    assert.deepEqual(getCoverage(input, window), { spans: expected, covered: units.length });
    assert.deepEqual(input, before);
  }
});
