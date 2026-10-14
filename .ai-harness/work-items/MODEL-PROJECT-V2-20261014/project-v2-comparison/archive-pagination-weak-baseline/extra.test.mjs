import test from "node:test";
import assert from "node:assert/strict";
import { selectVisible } from "../src/repository.mjs";
import { listPage } from "../src/pagination.mjs";
import { fetchPage } from "../src/caller.mjs";
import { MAX_PAGE_SIZE } from "../src/limits.mjs";

// 修复前证据：公共测试 after:a, limit:1 期望 b/next:null，实际 a/next:a。
// 根因：先切原始数组、包含游标、未过滤归档、原地排序、末页无条件给游标。
// 以下回归约束这些行为的业务意图，避免翻页重复、遗漏及修改调用方数据。
const rows = [
  {id:"b",updatedAt:2,archived:false},
  {id:"hidden",updatedAt:0,archived:true},
  {id:"a",updatedAt:2,archived:false},
  {id:"Z",updatedAt:2,archived:false},
  {id:"first",updatedAt:1,archived:false},
];

test("repository filters before ordering and preserves caller-owned arrays and records",()=>{
  const input = rows.map(row=>({...row}));
  const before = structuredClone(input);
  assert.deepEqual(selectVisible(input).map(row=>row.id),["first","Z","a","b"]);
  assert.deepEqual(input,before);
  const frozen = Object.freeze(input.map(row=>Object.freeze(row)));
  assert.deepEqual(selectVisible(frozen).map(row=>row.id),["first","Z","a","b"]);
});

test("pagination traverses the complete visible order exactly once for every page size",()=>{
  for (const limit of [1,2,3,4,MAX_PAGE_SIZE]) {
    const seen = [];
    let after = null;
    for (let pages=0;pages<rows.length+1;pages++) {
      const page = listPage(rows,{after,limit});
      seen.push(...page.items.map(row=>row.id));
      assert.ok(page.items.every(row=>!row.archived));
      if (page.nextCursor===null) break;
      assert.equal(page.items.length,limit);
      assert.equal(page.nextCursor,page.items.at(-1).id);
      after = page.nextCursor;
    }
    assert.deepEqual(seen,["first","Z","a","b"]);
  }
});

test("empty and terminal pages must not advertise more visible data",()=>{
  for (const input of [[],rows.filter(row=>row.archived)]) {
    assert.deepEqual(listPage(input),{items:[],nextCursor:null});
  }
  assert.deepEqual(listPage(rows,{after:"b"}),{items:[],nextCursor:null});
  assert.deepEqual(fetchPage(rows,{after:"a",limit:1}),{records:[{id:"b",updatedAt:2}],next:null});
});

test("unknown, archived and non-string cursors cannot silently restart or skip data",()=>{
  for (const after of ["missing","hidden","",0,false,{},[],NaN]) {
    assert.throws(()=>listPage(rows,{after}),RangeError);
  }
  assert.throws(()=>listPage([],{after:"missing"}),RangeError);
});

test("page size bounds reject coercion and invalid sizes even when no records exist",()=>{
  for (const limit of [0,-1,1.5,MAX_PAGE_SIZE+1,NaN,Infinity,"2",null,true]) {
    for (const input of [rows,[]]) assert.throws(()=>listPage(input,{limit}),RangeError);
  }
  assert.deepEqual(listPage(rows),listPage(rows,{after:null,limit:2}));
  assert.deepEqual(listPage(rows,{after:undefined,limit:undefined}),listPage(rows));
  assert.equal(listPage(rows,{limit:MAX_PAGE_SIZE}).nextCursor,null);
});

test("id tie-breaking uses JavaScript string order rather than locale collation",()=>{
  const ids = ["é","a","😀","Z","𐀀","ä"];
  const input = ids.map(id=>({id,updatedAt:0,archived:false}));
  assert.deepEqual(selectVisible(input).map(row=>row.id),[...ids].sort());
});

// 实际执行证据：node --test test/public.test.mjs（修复前）1通过、1失败。
// node --test test/public.test.mjs test/extra.test.mjs：修复前1通过、7失败；修复后8通过、0失败、0跳过。
// 修复：完整可见集合非原地排序，校验limit/after，排他切片，仅有后续数据时返回游标。
