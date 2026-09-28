import { projectTasks } from "./project-tasks.mjs";

const configSpecification = `修复配置层叠读取。layers是稠密数组，每项有唯一非空字符串id、非负安全整数priority、布尔enabled及仅含自有字符串键的普通values对象（值可为任意JavaScript值，包含undefined）；不需要扩展输入校验。
orderedLayers(layers)只返回enabled的层，按priority升序、相同priority按id的JavaScript字符串顺序排序；不能修改输入数组或层对象。
resolveConfig(layers)按上述顺序合并values；后面的层覆盖同名键，null是普通值，字符串键（含__proto__）都应作为自有数据属性保留，结果为新对象。不得修改输入或values。
保留只读caller.readConfig(layers)的{config,keys}契约，其中keys是最终config的自有键按JavaScript字符串顺序排序。保留现有模块导出，不改只读caller、TASK.md或原公共测试；无数据库、网络和依赖安装。`;

const configFiles = {
  "src/layers.mjs": 'export function orderedLayers(layers) { return layers.sort((a,b) => a.priority-b.priority); }\n',
  "src/config.mjs": 'import { orderedLayers } from "./layers.mjs";\nexport function resolveConfig(layers) { return Object.assign({}, ...layers.map(layer => layer.values)); }\n',
  "src/caller.mjs": 'import { resolveConfig } from "./config.mjs";\nexport function readConfig(layers) { const config=resolveConfig(layers); return {config,keys:Object.keys(config).sort()}; }\n',
  "test/public.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/caller.mjs";
test("one enabled layer keeps the caller result shape",()=>{assert.deepEqual(readConfig([{id:"a",priority:0,enabled:true,values:{x:1}}]),{config:{x:1},keys:["x"]});});
test("disabled overrides do not win and priority, not input order, decides",()=>{assert.deepEqual(readConfig([{id:"higher",priority:2,enabled:true,values:{x:2}},{id:"off",priority:9,enabled:false,values:{x:9}},{id:"lower",priority:1,enabled:true,values:{x:1}}]),{config:{x:2},keys:["x"]});});
`,
  "TASK.md": `# config-layers\n\n类型：BUGFIX。实际：禁用层仍参与合并、覆盖顺序由输入顺序决定且排序可能改动输入。期望：仅启用层按优先级和id稳定覆盖，保持配置键安全及只读调用方契约。复现：node --test test/public.test.mjs。\n\n${configSpecification}\n\n只允许修改src/layers.mjs、src/config.mjs及新增test/extra.test.mjs。先读调用方和两个实现，再复现、修复、回归；保留失败证据和根因说明。\n`,
};

const windowSpecification = `修复半开区间归并与窗口裁剪。intervals为稠密数组，项为{start,end}，均为0至1000000的安全整数且start<end；window也满足相同约束，不需要扩展输入校验。
mergeIntervals(intervals)先按start、再按end升序排列，重叠或首尾相接的区间合成单个区间；返回新的{start,end}对象数组，不修改输入或原记录。
clipWindow(intervals,window)先对每个区间取与window的非空交集，再归并并排序；不能把窗口外长度算入结果，也不能修改输入。
保留只读caller.getCoverage(intervals,window)的{spans,covered}契约，covered为spans各长度之和。保留模块现有导出，不改只读caller、TASK.md或原公共测试；无数据库、网络和依赖安装。`;

const windowFiles = {
  "src/intervals.mjs": 'export function mergeIntervals(intervals) { return intervals.sort((a,b) => a.start-b.start); }\n',
  "src/window.mjs": 'import { mergeIntervals } from "./intervals.mjs";\nexport function clipWindow(intervals, window) { return mergeIntervals(intervals.filter(row => row.end > window.start && row.start < window.end)); }\n',
  "src/caller.mjs": 'import { clipWindow } from "./window.mjs";\nexport function getCoverage(intervals, window) { const spans=clipWindow(intervals,window); return {spans,covered:spans.reduce((sum,row)=>sum+row.end-row.start,0)}; }\n',
  "test/public.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { getCoverage } from "../src/caller.mjs";
test("one interval wholly inside a window",()=>{assert.deepEqual(getCoverage([{start:1,end:3}],{start:0,end:4}),{spans:[{start:1,end:3}],covered:2});});
test("overlaps must be merged after clipping",()=>{assert.deepEqual(getCoverage([{start:0,end:3},{start:2,end:7}],{start:1,end:5}),{spans:[{start:1,end:5}],covered:4});});
`,
  "TASK.md": `# window-intervals\n\n类型：BUGFIX。实际：区间只排序不归并、原地修改输入，窗口交集未裁剪，导致覆盖长度重复或超出窗口。期望：半开区间的纯函数归并、裁剪及只读调用方覆盖汇总协同工作。复现：node --test test/public.test.mjs。\n\n${windowSpecification}\n\n只允许修改src/intervals.mjs、src/window.mjs及新增test/extra.test.mjs。先读调用方和两个实现，再复现、修复、回归；保留失败证据和根因说明。\n`,
};

export const projectTasksV2 = [...projectTasks,
  {
    id: "config-layers", split: "development", type: "BUGFIX", entry: "src/caller.mjs", name: "readConfig", specification: configSpecification,
    writableFiles: ["src/layers.mjs", "src/config.mjs"], files: configFiles,
    cases: [
      ["priority-over-input", 'assert.deepEqual(f([{id:"high",priority:3,enabled:true,values:{x:3}},{id:"low",priority:1,enabled:true,values:{x:1}}]).config,{x:3});'],
      ["disabled-layer", 'assert.deepEqual(f([{id:"off",priority:3,enabled:false,values:{x:9}},{id:"on",priority:1,enabled:true,values:{x:1}}]).config,{x:1});'],
      ["equal-priority-id-order", 'assert.deepEqual(f([{id:"z",priority:1,enabled:true,values:{x:2}},{id:"a",priority:1,enabled:true,values:{x:1}}]).config,{x:2});'],
      ["sorted-keys", 'assert.deepEqual(f([{id:"a",priority:1,enabled:true,values:{z:1,a:2}}]).keys,["a","z"]);'],
      ["null-is-value", 'assert.deepEqual(f([{id:"a",priority:1,enabled:true,values:{x:1}},{id:"b",priority:2,enabled:true,values:{x:null}}]).config,{x:null});'],
      ["empty-and-disabled", 'for(const rows of [[],[{id:"off",priority:1,enabled:false,values:{a:1}}]])assert.deepEqual(f(rows),{config:{},keys:[]});'],
      ["input-immutable", 'const rows=Object.freeze([Object.freeze({id:"z",priority:2,enabled:true,values:Object.freeze({x:2})}),Object.freeze({id:"a",priority:1,enabled:true,values:Object.freeze({x:1})})]);assert.deepEqual(f(rows).config,{x:2});assert.equal(rows[0].id,"z");'],
      ["prototype-key", 'const values=JSON.parse("{\\"__proto__\\":\\"safe\\"}");const config=f([{id:"a",priority:0,enabled:true,values}]).config;assert.equal(Object.hasOwn(config,"__proto__"),true);assert.equal(config.__proto__,"safe");assert.equal(Object.getPrototypeOf(config),Object.prototype);'],
      ["source-not-aliased", 'const fn=()=>1,values={a:undefined,fn};const result=f([{id:"a",priority:0,enabled:true,values}]);assert.notEqual(result.config,values);assert.equal(Object.hasOwn(result.config,"a"),true);assert.equal(result.config.a,undefined);assert.equal(result.config.fn,fn);assert.deepEqual(result.keys,["a","fn"]);assert.deepEqual(values,{a:undefined,fn});'],
      ["ordered-layers-contract", 'const {orderedLayers}=await import("./src/layers.mjs");const rows=Object.freeze([{id:"b",priority:2,enabled:true,values:{}},{id:"off",priority:1,enabled:false,values:{}},{id:"a",priority:1,enabled:true,values:{}}]);assert.deepEqual(orderedLayers(rows).map(row=>row.id),["a","b"]);'],
      ["resolve-config-contract", 'const {resolveConfig}=await import("./src/config.mjs");assert.deepEqual(resolveConfig([{id:"high",priority:3,enabled:true,values:{x:3}},{id:"low",priority:1,enabled:true,values:{x:1}}]),{x:3});'],
      ["caller-shape", 'assert.deepEqual(f([{id:"a",priority:0,enabled:true,values:{x:1}}]),{config:{x:1},keys:["x"]});'],
    ],
    reference: {
      "src/layers.mjs": `export function orderedLayers(layers) {
  return layers.filter(layer => layer.enabled).sort((a,b) => a.priority-b.priority || (a.id<b.id?-1:a.id>b.id?1:0));
}\n`,
      "src/config.mjs": `import { orderedLayers } from "./layers.mjs";
export function resolveConfig(layers) {
  return Object.fromEntries(orderedLayers(layers).flatMap(layer => Object.entries(layer.values)));
}\n`,
    },
  },
  {
    id: "window-intervals", split: "holdout", type: "BUGFIX", entry: "src/caller.mjs", name: "getCoverage", specification: windowSpecification,
    writableFiles: ["src/intervals.mjs", "src/window.mjs"], files: windowFiles,
    cases: [
      ["overlap", 'assert.deepEqual(f([{start:0,end:3},{start:2,end:5}],{start:0,end:6}),{spans:[{start:0,end:5}],covered:5});'],
      ["adjacent", 'assert.deepEqual(f([{start:0,end:2},{start:2,end:4}],{start:0,end:5}).spans,[{start:0,end:4}]);'],
      ["disjoint", 'assert.deepEqual(f([{start:0,end:2},{start:4,end:6}],{start:0,end:7}),{spans:[{start:0,end:2},{start:4,end:6}],covered:4});'],
      ["unsorted", 'assert.deepEqual(f([{start:4,end:5},{start:1,end:3},{start:2,end:4}],{start:0,end:6}).spans,[{start:1,end:5}]);'],
      ["duplicate", 'assert.deepEqual(f([{start:1,end:3},{start:1,end:3}],{start:0,end:4}),{spans:[{start:1,end:3}],covered:2});'],
      ["clip-left", 'assert.deepEqual(f([{start:0,end:5}],{start:2,end:6}),{spans:[{start:2,end:5}],covered:3});'],
      ["clip-right", 'assert.deepEqual(f([{start:3,end:9}],{start:1,end:5}),{spans:[{start:3,end:5}],covered:2});'],
      ["outside-window", 'assert.deepEqual(f([{start:0,end:2},{start:5,end:8}],{start:2,end:5}),{spans:[],covered:0});'],
      ["clip-then-merge", 'assert.deepEqual(f([{start:0,end:4},{start:4,end:9}],{start:2,end:6}),{spans:[{start:2,end:6}],covered:4});'],
      ["immutable-input", 'const rows=Object.freeze([Object.freeze({start:4,end:6}),Object.freeze({start:1,end:5})]);assert.deepEqual(f(rows,{start:2,end:5}),{spans:[{start:2,end:5}],covered:3});assert.equal(rows[0].start,4);'],
      ["merge-contract", 'const {mergeIntervals}=await import("./src/intervals.mjs");const a=Object.freeze({start:2,end:4}),b=Object.freeze({start:1,end:3}),rows=Object.freeze([a,b]);const merged=mergeIntervals(rows);assert.deepEqual(merged,[{start:1,end:4}]);assert.notEqual(merged[0],a);assert.notEqual(merged[0],b);assert.deepEqual(rows,[a,b]);'],
      ["window-contract", 'const {clipWindow}=await import("./src/window.mjs");const window=Object.freeze({start:1,end:5});assert.deepEqual(clipWindow([{start:0,end:3},{start:2,end:7}],window),[{start:1,end:5}]);assert.deepEqual(window,{start:1,end:5});'],
    ],
    reference: {
      "src/intervals.mjs": `export function mergeIntervals(intervals) {
  const ordered=[...intervals].sort((a,b)=>a.start-b.start||a.end-b.end),result=[];
  for(const row of ordered){const last=result.at(-1);if(last&&row.start<=last.end)last.end=Math.max(last.end,row.end);else result.push({start:row.start,end:row.end});}
  return result;
}\n`,
      "src/window.mjs": `import { mergeIntervals } from "./intervals.mjs";
export function clipWindow(intervals, window) {
  return mergeIntervals(intervals.map(row=>({start:Math.max(row.start,window.start),end:Math.min(row.end,window.end)})).filter(row=>row.start<row.end));
}\n`,
    },
  },
];
