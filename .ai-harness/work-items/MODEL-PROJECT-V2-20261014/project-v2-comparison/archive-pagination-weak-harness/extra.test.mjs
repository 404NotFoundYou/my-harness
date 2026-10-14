import test from "node:test";
import assert from "node:assert/strict";
import { selectVisible } from "../src/repository.mjs";
import { listPage } from "../src/pagination.mjs";
import { fetchPage } from "../src/caller.mjs";
import { MAX_PAGE_SIZE } from "../src/limits.mjs";

const row=(id,updatedAt=1,archived=false)=>({id,updatedAt,archived});

test("visibility and JS string tie order must not mutate shared caller input",()=>{
  const records=Object.freeze([row("z"),row("hidden",0,true),row("ä"),row("a"),row("Z"),row("early",0)].map(Object.freeze));
  const before=JSON.stringify(records);
  assert.deepEqual(selectVisible(records).map(r=>r.id),["early","Z","a","z","ä"]);
  assert.equal(JSON.stringify(records),before);
  assert.deepEqual(listPage(records).items.map(r=>r.id),["early","Z"]);
});

test("traversal must consume every visible row exactly once regardless of input order or page size",()=>{
  const records=[row("d",3),row("hidden",0,true),row("b",1),row("a",1),row("e",4),row("hidden2",2,true),row("c",2)];
  for (const limit of [1,2,3,5,MAX_PAGE_SIZE]) {
    let after=null;
    const ids=[];
    for (let step=0;step<=records.length;step++) {
      const page=listPage(records,{after,limit});
      ids.push(...page.items.map(r=>r.id));
      if (page.nextCursor===null) break;
      assert.equal(page.nextCursor,page.items.at(-1).id);
      after=page.nextCursor;
      assert.ok(step<records.length,"pagination must terminate");
    }
    assert.deepEqual(ids,["a","b","c","d","e"]);
  }
  assert.deepEqual(listPage(records,{after:"e"}),{items:[],nextCursor:null});
  assert.deepEqual(fetchPage(records,{after:"c",limit:2}),{records:[{id:"d",updatedAt:3},{id:"e",updatedAt:4}],next:null});
});

test("empty and all archived inputs have no continuation",()=>{
  for (const records of [[],[row("hidden",0,true)]]) assert.deepEqual(listPage(records),{items:[],nextCursor:null});
});

test("invalid cursors must fail rather than silently repeat or select unrelated rows",()=>{
  const records=[row("a"),row("hidden",0,true)];
  for (const after of ["missing","hidden","",0,false,{},[],new String("a")]) assert.throws(()=>listPage(records,{after}),RangeError);
  assert.throws(()=>listPage([],{after:"a"}),RangeError);
  assert.deepEqual(listPage(records,{after:undefined}).items,[records[0]]);
});

test("page-size bounds reject coercion and honor the fixed maximum",()=>{
  for (const limit of [0,-1,1.5,MAX_PAGE_SIZE+1,NaN,Infinity,"2",null,true,{},2n]) assert.throws(()=>listPage([],{limit}),RangeError);
  const records=Array.from({length:MAX_PAGE_SIZE+1},(_,i)=>row(String(i),i));
  const page=listPage(records,{limit:MAX_PAGE_SIZE});
  assert.equal(page.items.length,MAX_PAGE_SIZE);
  assert.equal(page.nextCursor,String(MAX_PAGE_SIZE-1));
  assert.deepEqual(listPage(records,{after:page.nextCursor,limit:MAX_PAGE_SIZE}),{items:[records.at(-1)],nextCursor:null});
});
