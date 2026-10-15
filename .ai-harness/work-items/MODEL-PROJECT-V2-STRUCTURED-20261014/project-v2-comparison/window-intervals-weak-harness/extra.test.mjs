import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.mjs";
import { clipWindow } from "../src/window.mjs";
import { getCoverage } from "../src/caller.mjs";

test("overlap, nesting, duplicates and touching spans count coverage only once",()=>{
  assert.deepEqual(mergeIntervals([{start:8,end:10},{start:2,end:5},{start:1,end:3},{start:5,end:8},{start:2,end:4},{start:1,end:3},{start:12,end:13}]),[{start:1,end:10},{start:12,end:13}]);
});
test("merging does not sort or mutate caller-owned records and returns fresh objects",()=>{
  const input = Object.freeze([Object.freeze({start:7,end:9}),Object.freeze({start:1,end:4}),Object.freeze({start:1,end:2})]);
  const spans = mergeIntervals(input);
  assert.deepEqual(spans,[{start:1,end:4},{start:7,end:9}]);
  for (const span of spans) for (const row of input) assert.notStrictEqual(span,row);
  spans[1].end = 10;
  assert.deepEqual(input,[{start:7,end:9},{start:1,end:4},{start:1,end:2}]);
});
test("half-open boundary contact contributes no length and both window edges are clipped",()=>{
  const input = Object.freeze([Object.freeze({start:0,end:2}),Object.freeze({start:8,end:10}),Object.freeze({start:1,end:4}),Object.freeze({start:6,end:9})]);
  const window = Object.freeze({start:2,end:8});
  assert.deepEqual(getCoverage(input,window),{spans:[{start:2,end:4},{start:6,end:8}],covered:4});
  assert.deepEqual(clipWindow([{start:0,end:10}],window),[{start:2,end:8}]);
});
test("empty and outside inputs have zero coverage, and maximum supported span is preserved",()=>{
  assert.deepEqual(mergeIntervals([]),[]);
  assert.deepEqual(getCoverage([],{start:1,end:2}),{spans:[],covered:0});
  assert.deepEqual(getCoverage([{start:0,end:1},{start:2,end:3}],{start:1,end:2}),{spans:[],covered:0});
  assert.deepEqual(getCoverage([{start:0,end:1000000}],{start:0,end:1000000}),{spans:[{start:0,end:1000000}],covered:1000000});
});
