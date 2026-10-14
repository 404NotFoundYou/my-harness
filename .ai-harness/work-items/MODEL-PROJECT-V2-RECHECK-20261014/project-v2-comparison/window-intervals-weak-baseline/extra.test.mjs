import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.mjs";
import { clipWindow } from "../src/window.mjs";
import { getCoverage } from "../src/caller.mjs";

// 修复前公共测试复现：node --test test/public.test.mjs，1 通过、1 失败。
// 输入 [0,3)、[2,7)，窗口 [1,5)：实际 covered=8，期望 spans=[1,5)、covered=4。
// 根因：mergeIntervals 原地排序但未归并；clipWindow 只过滤而未裁剪。
// 新增测试在旧实现上 7 项全部失败，包括冻结输入排序 TypeError。
// 修复：复制记录后按 start/end 排序归并；窗口先取非空交集再归并。
// 回归：node --test test/public.test.mjs test/extra.test.mjs，9 通过、0 失败、0 跳过。
// 组合测试额外覆盖 10 × 10 × 10 = 1000 组输入与窗口。

test("合并重叠、包含、重复及相接区间，避免覆盖长度重复累计", () => {
  assert.deepEqual(mergeIntervals([
    {start:9,end:10}, {start:2,end:4}, {start:0,end:2},
    {start:2,end:3}, {start:3,end:7}, {start:2,end:4},
  ]), [{start:0,end:7}, {start:9,end:10}]);
});

test("归并不改变输入顺序或记录，输出也不共享原记录", () => {
  const input = [{start:5,end:8}, {start:1,end:3}];
  const before = structuredClone(input);
  const result = mergeIntervals(input);
  assert.deepEqual(input, before);
  assert.notStrictEqual(result, input);
  for (const row of result) assert.ok(input.every(original => original !== row));
  result[0].end = 2;
  assert.deepEqual(input, before);
});

test("只读调用方可传入冻结区间，并得到裁剪后的联合覆盖长度", () => {
  const input = Object.freeze([
    Object.freeze({start:7,end:12}), Object.freeze({start:0,end:4}),
    Object.freeze({start:3,end:8}),
  ]);
  const window = Object.freeze({start:2,end:10});
  assert.deepEqual(mergeIntervals(input), [{start:0,end:12}]);
  assert.deepEqual(getCoverage(input, window), {spans:[{start:2,end:10}],covered:8});
});

test("半开窗口排除仅接触端点的区间，并裁剪两侧越界长度", () => {
  const input = [{start:8,end:10}, {start:0,end:2}, {start:6,end:9}, {start:1,end:4}];
  const before = structuredClone(input);
  const window = {start:2,end:8};
  const result = clipWindow(input, window);
  assert.deepEqual(result, [{start:2,end:4}, {start:6,end:8}]);
  assert.deepEqual(input, before);
  assert.deepEqual(window, {start:2,end:8});
  for (const row of result) {
    assert.notStrictEqual(row, window);
    assert.ok(input.every(original => original !== row));
  }
  result[0].start = 3;
  assert.deepEqual(input, before);
  assert.deepEqual(window, {start:2,end:8});
});

test("空输入及完全在窗口外的区间覆盖为零", () => {
  const input = [];
  const merged = mergeIntervals(input);
  assert.deepEqual(merged, []);
  assert.notStrictEqual(merged, input);
  assert.deepEqual(getCoverage([], {start:2,end:4}), {spans:[],covered:0});
  assert.deepEqual(getCoverage([{start:0,end:2}, {start:4,end:5}], {start:2,end:4}), {spans:[],covered:0});
});

test("合法坐标上界内的大区间按窗口长度计数而非原区间长度", () => {
  assert.deepEqual(getCoverage([{start:0,end:1000000}], {start:999999,end:1000000}), {
    spans:[{start:999999,end:1000000}], covered:1,
  });
});

test("用整数单位段独立核对组合输入的窗口联合覆盖，防止遗漏和重复计数", () => {
  const candidates = [];
  for (let start=0; start<4; start++) {
    for (let end=start+1; end<=4; end++) candidates.push({start,end});
  }
  for (const first of candidates) {
    for (const second of candidates) {
      for (const window of candidates) {
        const input = [second, first];
        const expected = [];
        let covered = 0;
        for (let point=window.start; point<window.end; point++) {
          if (!input.some(row => row.start<=point && point<row.end)) continue;
          covered++;
          const last = expected[expected.length-1];
          if (last && last.end===point) last.end=point+1;
          else expected.push({start:point,end:point+1});
        }
        assert.deepEqual(getCoverage(input, window), {spans:expected,covered});
      }
    }
  }
});
