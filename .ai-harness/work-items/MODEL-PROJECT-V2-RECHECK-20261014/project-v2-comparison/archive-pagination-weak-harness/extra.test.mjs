import test from "node:test";
import assert from "node:assert/strict";
import { selectVisible } from "../src/repository.mjs";
import { listPage } from "../src/pagination.mjs";
import { fetchPage } from "../src/caller.mjs";
import { MAX_PAGE_SIZE } from "../src/limits.mjs";

test("visible ordering uses JS string order without mutating caller-owned data",()=>{
  const rows=Object.freeze([
    Object.freeze({id:"a",updatedAt:2,archived:false}),
    Object.freeze({id:"hidden",updatedAt:0,archived:true}),
    Object.freeze({id:"Z",updatedAt:2,archived:false}),
    Object.freeze({id:"first",updatedAt:1,archived:false})
  ]);
  const before=JSON.stringify(rows);
  assert.deepEqual(selectVisible(rows).map(row=>row.id),["first","Z","a"]);
  assert.deepEqual(fetchPage(rows),{records:[{id:"first",updatedAt:1},{id:"Z",updatedAt:2}],next:"Z"});
  assert.equal(JSON.stringify(rows),before);
});

test("traversal neither loses nor repeats visible rows and stops at the last page",()=>{
  const rows=[{id:"c",updatedAt:3,archived:false},{id:"hidden",updatedAt:0,archived:true},{id:"b",updatedAt:1,archived:false},{id:"a",updatedAt:1,archived:false}];
  for (const limit of [1,2,3,MAX_PAGE_SIZE]) {
    let after=null;
    const ids=[];
    for (let step=0;step<4;step++) {
      const page=listPage(rows,{after,limit});
      ids.push(...page.items.map(row=>row.id));
      if (page.nextCursor===null) break;
      assert.equal(page.items.length,limit);
      assert.equal(page.nextCursor,page.items.at(-1).id);
      after=page.nextCursor;
    }
    assert.deepEqual(ids,["a","b","c"]);
  }
  assert.deepEqual(listPage(rows,{after:"c"}),{items:[],nextCursor:null});
});

test("empty and fully archived lists terminate without a cursor",()=>{
  for (const rows of [[],[{id:"hidden",updatedAt:0,archived:true}]]) {
    assert.deepEqual(listPage(rows),{items:[],nextCursor:null});
    assert.throws(()=>listPage(rows,{after:"hidden"}),RangeError);
  }
});

test("invalid cursors cannot restart traversal or expose archived rows",()=>{
  const rows=[{id:"a",updatedAt:0,archived:false},{id:"hidden",updatedAt:1,archived:true}];
  for (const after of ["missing","hidden","",0,false,{},[],NaN]) assert.throws(()=>listPage(rows,{after}),RangeError);
});

test("page size enforces the fixed limit without coercion",()=>{
  for (const limit of [0,-1,1.5,MAX_PAGE_SIZE+1,NaN,Infinity,-Infinity,"2",null,true,{},[]]) assert.throws(()=>listPage([],{limit}),RangeError);
  const rows=Array.from({length:MAX_PAGE_SIZE+1},(_,i)=>({id:String(i),updatedAt:i,archived:false}));
  const first=listPage(rows,{limit:MAX_PAGE_SIZE});
  assert.equal(first.items.length,MAX_PAGE_SIZE);
  assert.equal(first.nextCursor,String(MAX_PAGE_SIZE-1));
  assert.deepEqual(listPage(rows,{after:first.nextCursor,limit:MAX_PAGE_SIZE}),{items:[rows.at(-1)],nextCursor:null});
});
