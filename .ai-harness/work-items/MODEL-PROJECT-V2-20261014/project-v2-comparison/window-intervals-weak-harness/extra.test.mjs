import test from "node:test";
import assert from "node:assert/strict";
import { mergeIntervals } from "../src/intervals.mjs";
import { clipWindow } from "../src/window.mjs";
import { getCoverage } from "../src/caller.mjs";

test("merge touching, nested and duplicate intervals so coverage is counted once",()=>{
  const input=[{start:8,end:10},{start:2,end:6},{start:0,end:2},{start:2,end:3},{start:5,end:8},{start:2,end:6},{start:12,end:13}];
  assert.deepEqual(mergeIntervals(input),[{start:0,end:10},{start:12,end:13}]);
});
test("merge owns its output without sorting or mutating caller records",()=>{
  const input=Object.freeze([Object.freeze({start:4,end:5}),Object.freeze({start:1,end:2})]);
  const result=mergeIntervals(input);
  assert.deepEqual(result,[{start:1,end:2},{start:4,end:5}]);
  assert.notStrictEqual(result,input);
  for (const row of result) for (const original of input) assert.notStrictEqual(row,original);
  result[0].end=99;
  assert.deepEqual(input,[{start:4,end:5},{start:1,end:2}]);
});
test("clip excludes endpoint-only contact and all outside coverage without input mutation",()=>{
  const input=Object.freeze([{start:0,end:2},{start:1,end:4},{start:4,end:6},{start:8,end:10},{start:9,end:12}].map(Object.freeze));
  const window=Object.freeze({start:2,end:9});
  assert.deepEqual(getCoverage(input,window),{spans:[{start:2,end:6},{start:8,end:9}],covered:5});
  assert.deepEqual(clipWindow([{start:0,end:2},{start:9,end:12}],window),[]);
  assert.deepEqual(input,[{start:0,end:2},{start:1,end:4},{start:4,end:6},{start:8,end:10},{start:9,end:12}]);
  assert.deepEqual(window,{start:2,end:9});
});
test("empty, single, and full-domain intervals retain pure output and bounded coverage",()=>{
  assert.deepEqual(mergeIntervals([]),[]);
  assert.deepEqual(getCoverage([],{start:0,end:1000000}),{spans:[],covered:0});
  const row={start:0,end:1000000};
  const merged=mergeIntervals([row]);
  assert.deepEqual(merged,[row]);
  assert.notStrictEqual(merged[0],row);
  const clipped=clipWindow([row],{start:1,end:999999});
  assert.deepEqual(clipped,[{start:1,end:999999}]);
  clipped[0].start=12;
  assert.deepEqual(row,{start:0,end:1000000});
});
