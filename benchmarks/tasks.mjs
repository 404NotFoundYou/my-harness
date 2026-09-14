const publicTest = (entry, name, body) => `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { ${name} as f } from "../${entry}";\ntest("public contract", () => { ${body} });\n`;
const task = (id, split, entry, name, specification, implementation, caller, publicBody, cases, reference) => ({
  id, split, entry, name, specification, cases, reference,
  files: {
    [entry]: implementation,
    "src/caller.mjs": caller,
    "test/public.test.mjs": publicTest(entry, name, publicBody),
    "TASK.md": `# ${id}\n\n实现 ${entry} 导出的 ${name}，保持 src/caller.mjs 兼容。\n\n${specification}\n\n只允许修改 ${entry} 和新增 test/extra.test.mjs；其余公开文件不可修改。无依赖安装、外部服务或数据库影响。公共验证：node --test test/public.test.mjs；新增自测后也要实际运行。\n`,
  },
});

export const tasks = [
  task("csv", "development", "src/csv.mjs", "parseCsv",
    "输入必须是字符串，否则抛 TypeError。返回二维字符串数组。空字符串及仅一个开头BOM返回[]；只移除开头一个BOM。逗号分字段，CRLF/LF/CR在引号外分记录，空行保留为一个空字段，末尾记录分隔符不额外增加记录。保留空字段、所有空白和引号内原始换行。双引号只能从字段开头开始，内部两个双引号表示一个字面双引号；闭合引号后只能出现逗号、记录分隔符或输入结束。未闭合引号、裸字段中的双引号、闭合引号后的其他字符均抛 SyntaxError。",
    'export function parseCsv(text) { return text.split("\\n").map(row => row.split(",")); }\n',
    'import { parseCsv } from "./csv.mjs";\nexport function importRows(text) { return parseCsv(text).map(fields => ({ fields, width: fields.length })); }\n',
    'assert.deepEqual(f("a,b\\nc,d"), [["a","b"],["c","d"]]); assert.deepEqual(f("x,,"), [["x","",""]]);',
    [
      ["empty", 'assert.deepEqual(f(""), []); assert.deepEqual(f("\\ufeff"), []);'],
      ["bom", 'assert.deepEqual(f("\\ufeffa,\\ufeffb"), [["a","\\ufeffb"]]);'],
      ["delimiters", 'assert.deepEqual(f("a,b\\r\\nc,d\\re,f\\n"), [["a","b"],["c","d"],["e","f"]]);'],
      ["blank-rows", 'assert.deepEqual(f("\\n\\n"), [[""],[""]]); assert.deepEqual(f(",\\n"), [["",""]]);'],
      ["quoted-fields", 'assert.deepEqual(f(\'"a,b","c"\'), [["a,b","c"]]);'],
      ["escaped-quotes", 'assert.deepEqual(f(\'"a""b",""\'), [[\'a"b\',""]]);'],
      ["embedded-newline", 'assert.deepEqual(f(\'"a\\r\\nb\\nc",d\'), [["a\\r\\nb\\nc","d"]]);'],
      ["whitespace", 'assert.deepEqual(f(\' a ," b "\'), [[" a "," b "]]);'],
      ["unterminated", 'assert.throws(() => f(\'"abc\'), SyntaxError);'],
      ["bare-quote", 'assert.throws(() => f(\'ab"c\'), SyntaxError);'],
      ["after-quote", 'assert.throws(() => f(\'"ab" c\'), SyntaxError); assert.throws(() => f(\'"ab"x\'), SyntaxError);'],
      ["input-type", 'for (const value of [null, 42, ["a"]]) assert.throws(() => f(value), TypeError);'],
    ],
    `export function parseCsv(input) {
  if (typeof input !== "string") throw new TypeError();
  const text = input.startsWith("\\ufeff") ? input.slice(1) : input;
  if (!text.length) return [];
  const rows = []; let row = [], field = "", mode = "start", ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; ended = false;
    if (mode === "quoted") { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else mode = "closed"; } else field += c; continue; }
    if (c === "," || c === "\\r" || c === "\\n") {
      row.push(field); field = ""; mode = "start";
      if (c !== ",") { rows.push(row); row = []; ended = true; if (c === "\\r" && text[i + 1] === "\\n") i++; }
    } else if (c === '"' && mode === "start") mode = "quoted";
    else { if (c === '"' || mode === "closed") throw new SyntaxError(); field += c; mode = "plain"; }
  }
  if (mode === "quoted") throw new SyntaxError();
  if (!ended) { row.push(field); rows.push(row); }
  return rows;
}\n`),
  task("allocation", "development", "src/allocate.mjs", "allocate",
    "allocate(total, weights)返回整数数组，将total按权重分配，结果顺序对应输入。total和每个weight必须是非负安全整数，weights必须是非空稠密数组；非法输入均抛RangeError。权重总和为0时total=0返回全0，否则抛RangeError。按精确最大余数法：先取每个精确份额的下整数，再按精确余数从大到小逐个补1，同余数时原索引小者优先。适用于整个JavaScript安全整数范围，权重之和或total×weight可能超过安全整数。总和必须精确等于total，零权重分配0，禁止修改输入。",
    'export function allocate(total, weights) { const sum = weights.reduce((a,b) => a+b,0); return weights.map(w => Math.round(total*w/sum)); }\n',
    'import { allocate } from "./allocate.mjs";\nexport function invoice(total, lines) { const amounts = allocate(total, lines.map(line => line.weight)); return lines.map((line,i) => ({ ...line, amount: amounts[i] })); }\n',
    'assert.deepEqual(f(10,[1,1]),[5,5]); assert.deepEqual(f(12,[1,2,3]),[2,4,6]);',
    [
      ["conservation", 'assert.deepEqual(f(10,[1,1,1]),[4,3,3]);'],
      ["remainder-order", 'assert.deepEqual(f(5,[1,2,3]),[1,2,2]);'],
      ["zero-weight", 'assert.deepEqual(f(5,[0,1,0]),[0,5,0]);'],
      ["zero-total", 'assert.deepEqual(f(0,[0,0]),[0,0]);'],
      ["zero-sum", 'assert.throws(() => f(2,[0,0]),RangeError);'],
      ["invalid-total", 'for(const n of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,"3"]) assert.throws(() => f(n,[1]),RangeError);'],
      ["invalid-weights", 'for(const ws of [[],null,[1,-1],[0.5],[NaN],["1"],Array(2)]) assert.throws(() => f(3,ws),RangeError);'],
      ["immutable", 'const w=Object.freeze([1,1,2]); assert.deepEqual(f(3,w),[1,1,1]);'],
      ["large-total", 'assert.deepEqual(f(Number.MAX_SAFE_INTEGER,[1,1]),[4503599627370496,4503599627370495]);'],
      ["large-weights", 'assert.deepEqual(f(3,[Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER-1]),[2,1]);'],
      ["exact-order", 'const m=Number.MAX_SAFE_INTEGER; assert.deepEqual(f(m,[m-1,m]),[4503599627370495,4503599627370496]);'],
      ["many-shares", 'const r=f(7,Array(10).fill(1)); assert.deepEqual(r,[1,1,1,1,1,1,1,0,0,0]);'],
    ],
    `export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights) || !weights.length) throw new RangeError();
  for (let i=0;i<weights.length;i++) if (!Object.hasOwn(weights,i) || !Number.isSafeInteger(weights[i]) || weights[i]<0) throw new RangeError();
  const sum=weights.reduce((a,b)=>a+BigInt(b),0n);
  if (sum===0n) { if (total) throw new RangeError(); return weights.map(()=>0); }
  const shares=weights.map((w,i)=>{ const n=BigInt(total)*BigInt(w); return {i,amount:n/sum,remainder:n%sum}; });
  let remaining=BigInt(total)-shares.reduce((a,s)=>a+s.amount,0n);
  for (const share of [...shares].sort((a,b)=>a.remainder===b.remainder?a.i-b.i:a.remainder>b.remainder?-1:1)) { if (!remaining) break; share.amount++; remaining--; }
  return shares.map(s=>Number(s.amount));
}\n`),
  task("events", "holdout", "src/reconcile.mjs", "reconcile",
    "reconcile(current, events)纯函数返回按id的JavaScript字符串比较排序的记录数组。current为唯一id记录，形态{id,version,deleted,value?}；events为按到达顺序的{id,version,type:'upsert'|'delete',value?}。id为任意非空字符串，version为非负安全整数，deleted为布尔。upsert及非删除记录必须有自有value属性，value可为任意JSON值。两参数均为稠密数组；任何非法项或current重复id使整个调用抛TypeError，不修改任何输入。每个id仅接受比已知version更大的事件；相同版本先存在/先到达者胜出。删除保留{id,version,deleted:true}墓碑以挡住较旧更新；upsert产生{id,version,deleted:false,value}。输出记录只含这些字段，不修改或排序输入；再次应用相同事件须幂等。",
    'export function reconcile(current, events) { const records = Object.fromEntries(current.map(row => [row.id,row])); for (const e of events) { if (e.type === "delete") delete records[e.id]; else records[e.id] = {id:e.id,version:e.version,deleted:false,value:e.value}; } return Object.values(records); }\n',
    'import { reconcile } from "./reconcile.mjs";\nexport function sync(snapshot, events) { const records = reconcile(snapshot, events); return { records, visible: records.filter(row => !row.deleted) }; }\n',
    'assert.deepEqual(f([], [{id:"a",version:1,type:"upsert",value:1}]), [{id:"a",version:1,deleted:false,value:1}]);',
    [
      ["stale", 'assert.deepEqual(f([{id:"a",version:3,deleted:false,value:3}],[{id:"a",version:2,type:"upsert",value:2}]),[{id:"a",version:3,deleted:false,value:3}]);'],
      ["tombstone", 'assert.deepEqual(f([],[{id:"a",version:4,type:"delete"},{id:"a",version:2,type:"upsert",value:2}]),[{id:"a",version:4,deleted:true}]);'],
      ["same-version", 'assert.deepEqual(f([],[{id:"a",version:1,type:"upsert",value:1},{id:"a",version:1,type:"delete"}]),[{id:"a",version:1,deleted:false,value:1}]);'],
      ["resurrection", 'assert.deepEqual(f([{id:"a",version:2,deleted:true}],[{id:"a",version:3,type:"upsert",value:null}]),[{id:"a",version:3,deleted:false,value:null}]);'],
      ["idempotent", 'const e=[{id:"b",version:2,type:"delete"},{id:"a",version:1,type:"upsert",value:{x:1}}]; const r=f([],e); assert.deepEqual(f(r,e),r);'],
      ["sorted", 'assert.deepEqual(f([{id:"z",version:0,deleted:true},{id:"a",version:0,deleted:true}],[]).map(x=>x.id),["a","z"]);'],
      ["ordinary-string-ids", 'assert.deepEqual(f([],[{id:"__proto__",version:1,type:"upsert",value:1},{id:"constructor",version:1,type:"delete"}]).map(x=>x.id),["__proto__","constructor"]);'],
      ["immutable", 'const c=Object.freeze([Object.freeze({id:"a",version:1,deleted:false,value:1})]);const e=Object.freeze([Object.freeze({id:"a",version:2,type:"delete"})]);assert.deepEqual(f(c,e),[{id:"a",version:2,deleted:true}]);assert.equal(c[0].value,1);'],
      ["invalid-shape", 'for(const e of [null,[{}],[{id:"a",version:1,type:"upsert"}],Array(1)]) assert.throws(()=>f([],e),TypeError);'],
      ["invalid-version", 'for(const version of [-1,0.5,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>f([],[{id:"a",version,type:"delete"}]),TypeError);'],
      ["duplicate-current", 'assert.throws(()=>f([{id:"a",version:1,deleted:true},{id:"a",version:2,deleted:true}],[]),TypeError);'],
      ["clean-fields", 'assert.deepEqual(f([{id:"a",version:0,deleted:true,value:1,extra:true}],[]),[{id:"a",version:0,deleted:true}]);'],
    ],
    `export function reconcile(current, events) {
  const dense=a=>Array.isArray(a)&&Array.from({length:a.length},(_,i)=>Object.hasOwn(a,i)).every(Boolean);
  const base=x=>x&&typeof x.id==="string"&&x.id.length&&Number.isSafeInteger(x.version)&&x.version>=0;
  if(!dense(current)||!dense(events))throw new TypeError(); const map=new Map();
  for(const r of current){if(!base(r)||typeof r.deleted!=="boolean"||(!r.deleted&&!Object.hasOwn(r,"value"))||map.has(r.id))throw new TypeError();map.set(r.id,r.deleted?{id:r.id,version:r.version,deleted:true}:{id:r.id,version:r.version,deleted:false,value:r.value});}
  for(const e of events){if(!base(e)||!["upsert","delete"].includes(e.type)||(e.type==="upsert"&&!Object.hasOwn(e,"value")))throw new TypeError();const old=map.get(e.id);if(old&&old.version>=e.version)continue;map.set(e.id,e.type==="delete"?{id:e.id,version:e.version,deleted:true}:{id:e.id,version:e.version,deleted:false,value:e.value});}
  return [...map.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}\n`),
];
