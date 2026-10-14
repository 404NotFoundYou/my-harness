import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.mjs";
import { clipWindow } from "../src/window.mjs";
import { getCoverage } from "../src/caller.mjs";

// 修复前证据：node --test test/public.test.mjs，2 项中 1 项失败。
// 输入 [0,3)、[2,7)，窗口 [1,5)：实际 spans=[0,3)、[2,7)，covered=8；
// 期望 spans=[1,5)，covered=4。根因：原地排序但未归并，筛选相交但未裁剪。
// 实测记录：修复前新增测试 6/6 失败；修复后公共与新增测试 8/8 通过，无跳过。
// 回归命令：node --test test/public.test.mjs test/extra.test.mjs（含 3375 组穷举核对）。
// 回归意图：避免重复及窗口外计数，同时保证只读调用方不受输入修改或引用别名影响。

test("merge collapses nested, duplicate and touching spans without filling gaps", () => {
  assert.deepEqual(mergeIntervals([
    {start:8,end:10}, {start:3,end:5}, {start:1,end:4},
    {start:1,end:2}, {start:5,end:6}, {start:1,end:4}
  ]), [{start:1,end:6}, {start:8,end:10}]);
});

test("merge accepts frozen input and returns independent records", () => {
  const intervals = Object.freeze([
    Object.freeze({start:8,end:10}), Object.freeze({start:1,end:3})
  ]);
  const spans = mergeIntervals(intervals);
  assert.deepEqual(spans, [{start:1,end:3}, {start:8,end:10}]);
  assert.notStrictEqual(spans, intervals);
  for (const span of spans) assert.ok(!intervals.includes(span));
  spans[0].end = 2;
  assert.equal(intervals[1].end, 3);
});

test("a single span and an empty list also return fresh arrays and records", () => {
  const empty = [];
  assert.deepEqual(mergeIntervals(empty), []);
  assert.notStrictEqual(mergeIntervals(empty), empty);
  const intervals = [{start:0,end:1000000}];
  const spans = mergeIntervals(intervals);
  assert.deepEqual(spans, intervals);
  assert.notStrictEqual(spans, intervals);
  assert.notStrictEqual(spans[0], intervals[0]);
});

test("half-open window excludes endpoint-only contact and preserves gaps", () => {
  const intervals = [
    {start:7,end:9}, {start:0,end:2}, {start:1,end:3},
    {start:5,end:8}, {start:3,end:4}
  ];
  assert.deepEqual(getCoverage(intervals, {start:2,end:7}), {
    spans:[{start:2,end:4}, {start:5,end:7}], covered:4
  });
  assert.deepEqual(clipWindow([{start:0,end:2}, {start:7,end:9}], {start:2,end:7}), []);
  assert.deepEqual(getCoverage([], {start:0,end:1000000}), {spans:[],covered:0});
});

test("clipping and coverage preserve frozen inputs, window and result independence", () => {
  const intervals = Object.freeze([
    Object.freeze({start:4,end:1000000}), Object.freeze({start:0,end:5})
  ]);
  const window = Object.freeze({start:2,end:8});
  const result = getCoverage(intervals, window);
  assert.deepEqual(result, {spans:[{start:2,end:8}],covered:6});
  result.spans[0].start = 3;
  assert.equal(intervals[0].start, 4);
  assert.equal(intervals[1].start, 0);
  assert.equal(window.start, 2);
  const contained = [{start:3,end:4}];
  assert.notStrictEqual(clipWindow(contained, window)[0], contained[0]);
});

test("coverage matches an independent unit-cell union for all small pairs and windows", () => {
  const choices = [];
  for (let start=0; start<5; start++) {
    for (let end=start+1; end<=5; end++) choices.push({start,end});
  }
  for (const first of choices) for (const second of choices) for (const window of choices) {
    const intervals = [first,second];
    const spans = [];
    let covered = 0;
    for (let point=window.start; point<window.end; point++) {
      if (!intervals.some(row => row.start<=point && point<row.end)) continue;
      covered++;
      const last = spans[spans.length-1];
      if (last && last.end===point) last.end++;
      else spans.push({start:point,end:point+1});
    }
    assert.deepEqual(getCoverage(intervals,window), {spans,covered});
  }
});
