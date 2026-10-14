import test from "node:test";
import assert from "node:assert/strict";
import { orderedLayers } from "../src/layers.mjs";
import { resolveConfig } from "../src/config.mjs";
import { readConfig } from "../src/caller.mjs";

// 修复前公共测试证据：实际 config.x 为 1，期望为 2（1 通过、1 失败）。
// 根因：合并绕过排序与启用过滤；排序原地修改输入且缺少 id 次序；
// Object.assign 会触发 __proto__ setter，且遗漏不可枚举的自有键。
// 修复前新增测试：node --test test/extra.test.mjs，1 通过、5 失败。
// 失败包括冻结数组排序 TypeError，以及 __proto__ 导致结果原型改变。
// 修复：过滤后排序，并按顺序将全部自有字符串键定义为数据属性。
// 修复后联合回归：node --test test/public.test.mjs test/extra.test.mjs，8 通过、0 失败、0 跳过。

test("only enabled layers participate, so disabled values never leak", () => {
  const layers = [
    {id:"on",priority:0,enabled:true,values:{x:1}},
    {id:"off",priority:9,enabled:false,values:{x:9,hidden:true}}
  ];
  assert.deepEqual(orderedLayers(layers), [layers[0]]);
  assert.deepEqual(readConfig(layers), {config:{x:1},keys:["x"]});
});

test("priority and JavaScript id order decide overrides independently of input order", () => {
  const layers = [
    {id:"a",priority:1,enabled:true,values:{x:"a"}},
    {id:"Z",priority:1,enabled:true,values:{x:"Z"}},
    {id:"😀",priority:1,enabled:true,values:{x:"emoji"}},
    {id:"\uE000",priority:1,enabled:true,values:{x:"private"}},
    {id:"first",priority:0,enabled:true,values:{x:"first"}}
  ];
  const expected = [layers[4],layers[1],layers[0],layers[2],layers[3]];
  for (const input of [layers, [...layers].reverse()]) {
    assert.deepEqual(orderedLayers(input), expected);
    assert.equal(resolveConfig(input).x, "private");
  }
  assert.equal(resolveConfig([
    {id:"high",priority:Number.MAX_SAFE_INTEGER,enabled:true,values:{x:2}},
    {id:"low",priority:0,enabled:true,values:{x:1}}
  ]).x, 2);
});

test("read-only callers can reuse frozen inputs without mutation", () => {
  const high = Object.freeze({id:"high",priority:2,enabled:true,values:Object.freeze({x:2})});
  const low = Object.freeze({id:"low",priority:1,enabled:true,values:Object.freeze({x:1})});
  const layers = Object.freeze([high,low]);
  const ordered = orderedLayers(layers);
  assert.notEqual(ordered, layers);
  assert.equal(ordered[0], low);
  assert.equal(ordered[1], high);
  assert.deepEqual(readConfig(layers), {config:{x:2},keys:["x"]});
  assert.deepEqual(layers, [high,low]);
});

test("null and undefined explicitly override earlier values without cloning arbitrary values", () => {
  const shared = {nested:true};
  const fn = () => 1;
  const values = {n:null,u:undefined,shared,fn};
  const config = resolveConfig([
    {id:"old",priority:0,enabled:true,values:{n:1,u:2}},
    {id:"new",priority:1,enabled:true,values}
  ]);
  assert.deepEqual(config, values);
  assert.ok(Object.hasOwn(config,"u"));
  assert.notEqual(config, values);
  assert.equal(config.shared, shared);
  assert.equal(config.fn, fn);
});

test("special and non-enumerable own string keys remain data, not prototype changes", () => {
  const payload = {polluted:true};
  const values = Object.freeze(Object.defineProperties({}, {
    ["__proto__"]: {value:payload,enumerable:true},
    constructor: {value:"own constructor",enumerable:true},
    secret: {value:undefined,enumerable:false},
    "10": {value:10,enumerable:true},
    "2": {value:2,enumerable:true}
  }));
  const {config,keys} = readConfig([{id:"safe",priority:0,enabled:true,values}]);
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  assert.equal(Object.hasOwn(config,"__proto__"), true);
  assert.equal(Object.getOwnPropertyDescriptor(config,"__proto__").value, payload);
  assert.equal(Object.hasOwn(config,"polluted"), false);
  assert.equal(config.polluted, undefined);
  assert.deepEqual(keys, ["10","2","__proto__","constructor","secret"]);
  assert.equal(Object.hasOwn(config,"secret"), true);
  assert.equal(config.secret, undefined);
});

test("empty and fully disabled inputs return fresh empty configurations", () => {
  const first = resolveConfig([]);
  assert.deepEqual(first, {});
  assert.notEqual(first, resolveConfig([]));
  assert.deepEqual(readConfig([{id:"off",priority:0,enabled:false,values:{x:1}}]), {config:{},keys:[]});
});
