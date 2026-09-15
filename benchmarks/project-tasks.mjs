const specification = `修复归档过滤与游标分页联动错误。输入records是稠密数组，记录拥有唯一非空字符串id、非负安全整数updatedAt和布尔archived；不需要扩展这部分输入校验。
repository.selectVisible(records)只返回未归档记录，按updatedAt升序、相同时按id的JavaScript字符串顺序排序，不修改输入数组或记录。
pagination.listPage(records, {after=null,limit=2}={})先使用完整的可见有序集合，再取after之后（排他）的limit条。after为null表示第一页，否则必须是可见记录的id，未知、归档或非字符串游标抛RangeError。limit必须是1至MAX_PAGE_SIZE的整数，否则抛RangeError。
返回{items,nextCursor}；只有后面还有可见记录时nextCursor才为本页最后一条的id，否则为null。空结果为{items:[],nextCursor:null}。不得重复、遗漏或让归档记录占用页大小。
保留repository/pagination现有导出及固定caller.fetchPage的{records:[{id,updatedAt}],next}输出契约，不改只读caller、limits、TASK.md或原公共测试。无数据库、网络、依赖安装；这是内存列表的工程BUG夹具。`;

const files = {
  "src/repository.mjs": 'export function selectVisible(records) { return records.sort((a,b) => a.updatedAt - b.updatedAt); }\n',
  "src/pagination.mjs": 'import { selectVisible } from "./repository.mjs";\nimport { MAX_PAGE_SIZE } from "./limits.mjs";\nexport function listPage(records, {after=null,limit=2}={}) { const start=after===null?0:records.findIndex(row=>row.id===after); const batch=records.slice(start,start+limit); return {items:selectVisible(batch),nextCursor:batch.at(-1)?.id??null}; }\n',
  "src/caller.mjs": 'import { listPage } from "./pagination.mjs";\nexport function fetchPage(records, request) { const page=listPage(records,request); return {records:page.items.map(({id,updatedAt})=>({id,updatedAt})),next:page.nextCursor}; }\n',
  "src/limits.mjs": 'export const MAX_PAGE_SIZE = 50;\n',
  "test/public.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { fetchPage } from "../src/caller.mjs";
test("existing first-page response",()=>{assert.deepEqual(fetchPage([{id:"a",updatedAt:1,archived:false},{id:"b",updatedAt:2,archived:false},{id:"c",updatedAt:3,archived:false}],{limit:2}),{records:[{id:"a",updatedAt:1},{id:"b",updatedAt:2}],next:"b"});});
test("archived rows must not consume a page or reappear after the cursor",()=>{const rows=[{id:"hidden",updatedAt:0,archived:true},{id:"b",updatedAt:2,archived:false},{id:"a",updatedAt:1,archived:false}];assert.deepEqual(fetchPage(rows,{after:"a",limit:1}),{records:[{id:"b",updatedAt:2}],next:null});});
`,
  "TASK.md": `# archive-pagination\n\n类型：BUGFIX。实际：归档行占用页大小、游标行重复、末页仍返回游标，且仓储排序修改输入。期望：过滤、稳定排序及排他游标协同工作。复现：node --test test/public.test.mjs。\n\n${specification}\n\n只允许修改src/repository.mjs、src/pagination.mjs及新增test/extra.test.mjs。先读取调用方和两个实现，再复现、修复、回归；保留失败证据和根因说明。\n`,
};

export const projectTasks = [{
  id: "archive-pagination", split: "development", type: "BUGFIX", entry: "src/caller.mjs", name: "fetchPage", specification,
  writableFiles: ["src/repository.mjs", "src/pagination.mjs"], files,
  cases: [
    ["visible-before-pagination", 'const rows=[{id:"x",updatedAt:0,archived:true},{id:"c",updatedAt:3,archived:false},{id:"a",updatedAt:1,archived:false},{id:"b",updatedAt:2,archived:false}];assert.deepEqual(f(rows,{limit:2}),{records:[{id:"a",updatedAt:1},{id:"b",updatedAt:2}],next:"b"});'],
    ["exclusive-cursor", 'assert.deepEqual(f([{id:"a",updatedAt:1,archived:false},{id:"b",updatedAt:2,archived:false}],{after:"a",limit:1}),{records:[{id:"b",updatedAt:2}],next:null});'],
    ["stable-tie", 'assert.deepEqual(f([{id:"b",updatedAt:1,archived:false},{id:"a",updatedAt:1,archived:false}],{limit:1}),{records:[{id:"a",updatedAt:1}],next:"a"});'],
    ["empty-and-archived", 'for(const rows of [[],[{id:"a",updatedAt:1,archived:true}]])assert.deepEqual(f(rows),{records:[],next:null});'],
    ["last-page", 'assert.deepEqual(f([{id:"a",updatedAt:1,archived:false}]),{records:[{id:"a",updatedAt:1}],next:null});'],
    ["unknown-cursor", 'const rows=[{id:"a",updatedAt:1,archived:true}];for(const after of ["missing","a",7,""])assert.throws(()=>f(rows,{after}),RangeError);'],
    ["invalid-page-size", 'for(const limit of [0,-1,1.5,51,"2",NaN,Infinity])assert.throws(()=>f([],{limit}),RangeError);'],
    ["page-size-boundary", 'const rows=Array.from({length:51},(_,i)=>({id:String(i).padStart(2,"0"),updatedAt:i,archived:false}));const page=f(rows,{limit:50});assert.equal(page.records.length,50);assert.equal(page.next,"49");assert.deepEqual(f(rows,{after:page.next,limit:50}),{records:[{id:"50",updatedAt:50}],next:null});'],
    ["immutable-input", 'const rows=Object.freeze([Object.freeze({id:"b",updatedAt:2,archived:false}),Object.freeze({id:"a",updatedAt:1,archived:false})]);assert.deepEqual(f(rows,{limit:1}),{records:[{id:"a",updatedAt:1}],next:"a"});assert.equal(rows[0].id,"b");'],
    ["repository-contract", 'const {selectVisible}=await import("./src/repository.mjs");const rows=Object.freeze([Object.freeze({id:"b",updatedAt:1,archived:false}),Object.freeze({id:"x",updatedAt:0,archived:true}),Object.freeze({id:"a",updatedAt:1,archived:false})]);assert.deepEqual(selectVisible(rows).map(row=>row.id),["a","b"]);'],
    ["pagination-contract", 'const {listPage}=await import("./src/pagination.mjs");const rows=[{id:"b",updatedAt:2,archived:false},{id:"x",updatedAt:0,archived:true},{id:"a",updatedAt:1,archived:false}];assert.deepEqual(listPage(rows,{after:"a",limit:1}),{items:[rows[0]],nextCursor:null});'],
    ["walk-without-duplicates", 'const rows=Array.from({length:9},(_,i)=>({id:String(i),updatedAt:i,archived:i%3===0})).reverse();const ids=[];let after=null;for(let i=0;i<5;i++){const page=f(rows,{after,limit:2});ids.push(...page.records.map(row=>row.id));if(page.next===null)break;after=page.next;}assert.deepEqual(ids,["1","2","4","5","7","8"]);'],
  ],
  reference: {
    "src/repository.mjs": `export function selectVisible(records) {
  return records.filter(row=>!row.archived).sort((a,b)=>a.updatedAt-b.updatedAt||(a.id<b.id?-1:a.id>b.id?1:0));
}\n`,
    "src/pagination.mjs": `import { selectVisible } from "./repository.mjs";
import { MAX_PAGE_SIZE } from "./limits.mjs";
export function listPage(records, {after=null,limit=2}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>MAX_PAGE_SIZE)throw new RangeError("Invalid limit");
  const visible=selectVisible(records);
  const index=after===null?-1:visible.findIndex(row=>row.id===after);
  if(after!==null&&(typeof after!=="string"||index<0))throw new RangeError("Invalid cursor");
  const start=index+1,items=visible.slice(start,start+limit);
  return {items,nextCursor:start+items.length<visible.length?items.at(-1).id:null};
}\n`,
  },
}];
