import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.mjs";
import { clipWindow } from "../src/window.mjs";
import { getCoverage } from "../src/caller.mjs";

test("union prevents duplicate coverage across nesting, duplicates and touching chains",()=>{
  const input = [{start:8,end:10},{start:2,end:6},{start:0,end:2},{start:2,end:4},{start:2,end:6},{start:6,end:8},{start:12,end:14}];
  assert.deepEqual(mergeIntervals(input),[{start:0,end:10},{start:12,end:14}]);
});

test("pure results protect frozen caller data and never alias original records",()=>{
  const input = Object.freeze([Object.freeze({start:6,end:8}),Object.freeze({start:1,end:3})]);
  const window = Object.freeze({start:0,end:10});
  for (const result of [mergeIntervals(input),clipWindow(input,window)]) {
    assert.notStrictEqual(result,input);
    assert.deepEqual(result,[{start:1,end:3},{start:6,end:8}]);
    for (const row of result) for (const original of input) assert.notStrictEqual(row,original);
    result[0].end = 9;
  }
  assert.deepEqual(input,[{start:6,end:8},{start:1,end:3}]);
  assert.deepEqual(window,{start:0,end:10});
});

test("half-open boundary contacts contribute no coverage; both edges are clipped",()=>{
  assert.deepEqual(getCoverage([{start:0,end:2},{start:8,end:10}],{start:2,end:8}),{spans:[],covered:0});
  assert.deepEqual(getCoverage([{start:6,end:10},{start:0,end:4}],{start:2,end:8}),{spans:[{start:2,end:4},{start:6,end:8}],covered:4});
  assert.deepEqual(clipWindow([{start:0,end:1000000}],{start:2,end:8}),[{start:2,end:8}]);
});

test("empty input and full legal range preserve coverage contract",()=>{
  assert.deepEqual(mergeIntervals([]),[]);
  assert.deepEqual(getCoverage([],{start:0,end:1}),{spans:[],covered:0});
  assert.deepEqual(getCoverage([{start:500000,end:1000000},{start:0,end:500000}],{start:0,end:1000000}),{spans:[{start:0,end:1000000}],covered:1000000});
});
