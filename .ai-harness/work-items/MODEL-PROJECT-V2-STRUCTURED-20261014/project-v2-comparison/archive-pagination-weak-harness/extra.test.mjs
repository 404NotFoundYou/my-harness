import test from "node:test";
import assert from "node:assert/strict";
import { selectVisible } from "../src/repository.mjs";
import { listPage } from "../src/pagination.mjs";
import { fetchPage } from "../src/caller.mjs";
import { MAX_PAGE_SIZE } from "../src/limits.mjs";
const row=(id,updatedAt=1,archived=false)=>({id,updatedAt,archived});
test("visible ordering uses JS string order without mutating shared input",()=>{
  const rows=Object.freeze([row("z"),row("hidden",0,true),row("a"),row("Z"),row("early",0)].map(Object.freeze));
  const before=JSON.stringify(rows);
  assert.deepEqual(selectVisible(rows).map(r=>r.id),["early","Z","a","z"]);
  assert.equal(JSON.stringify(rows),before);
  assert.notEqual(selectVisible(rows),rows);
});
test("walking all pages neither loses nor repeats visible records and preserves caller contract",()=>{
  const rows=Object.freeze([row("d",3),row("hidden",0,true),row("b"),row("a"),row("c",2)].map(Object.freeze));
  for (const limit of [1,2,3,MAX_PAGE_SIZE]) {
    const ids=[];
    let after=null;
    do {
      const page=fetchPage(rows,{after,limit});
      ids.push(...page.records.map(r=>r.id));
      assert.ok(page.records.every(r=>Object.keys(r).join(",")==="id,updatedAt"));
      after=page.next;
      assert.ok(ids.length<=4,"pagination must terminate without duplication");
    } while (after!==null);
    assert.deepEqual(ids,["a","b","c","d"]);
  }
  assert.deepEqual(listPage(rows,{after:"d"}),{items:[],nextCursor:null});
  assert.equal(listPage(rows).nextCursor,"b");
});
test("empty and all archived collections have no continuation",()=>{
  for (const rows of [[],[row("hidden",0,true)]]) assert.deepEqual(listPage(rows),{items:[],nextCursor:null});
});
test("invalid cursors are rejected instead of restarting or exposing archived rows",()=>{
  const rows=[row("a"),row("hidden",0,true)];
  for (const after of ["missing","hidden","",0,false,{},[],new String("a")]) assert.throws(()=>listPage(rows,{after}),RangeError);
  assert.throws(()=>listPage([],{after:"a"}),RangeError);
});
test("page size must stay within the fixed integer budget",()=>{
  for (const limit of [0,-1,1.5,MAX_PAGE_SIZE+1,NaN,Infinity,"2",null,true]) assert.throws(()=>listPage([],{limit}),RangeError);
  const rows=Array.from({length:MAX_PAGE_SIZE+1},(_,i)=>row(String(i),i));
  const page=listPage(rows,{limit:MAX_PAGE_SIZE});
  assert.equal(page.items.length,MAX_PAGE_SIZE);
  assert.equal(page.nextCursor,String(MAX_PAGE_SIZE-1));
  assert.deepEqual(listPage(rows,{after:page.nextCursor,limit:MAX_PAGE_SIZE}),{items:[rows.at(-1)],nextCursor:null});
});
