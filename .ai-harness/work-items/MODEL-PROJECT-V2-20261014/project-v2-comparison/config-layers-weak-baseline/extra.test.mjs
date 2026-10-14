import test from "node:test";
import assert from "node:assert/strict";
import { orderedLayers } from "../src/layers.mjs";
import { resolveConfig } from "../src/config.mjs";
import { readConfig } from "../src/caller.mjs";

// 修复前公共复现：2 项中 1 项失败，config.x 实际为 1，期望为 2。
// 根因：resolveConfig 按输入顺序合并且未过滤；orderedLayers 原地排序且缺少 id 比较。
// Object.assign 还会触发 __proto__ setter，无法保留该自有数据键。
const layer = (id, priority, values = {}, enabled = true) => ({ id, priority, enabled, values });

test("ordering must not mutate frozen caller input and must use JS string order", () => {
  const layers = Object.freeze([
    layer("a", 1), layer("off", 0, {}, false), layer("Z", 1),
    layer("first", 0), layer("😀", 1), layer("\uE000", 1),
    layer("last", Number.MAX_SAFE_INTEGER),
  ].map(item => Object.freeze({ ...item, values: Object.freeze(item.values) })));
  const before = [...layers];
  const result = orderedLayers(layers);
  assert.deepEqual(result.map(item => item.id), ["first", "Z", "a", "😀", "\uE000", "last"]);
  assert.notStrictEqual(result, layers);
  assert.deepEqual(layers, before);
  assert.strictEqual(result[0], layers[3]);
});

test("disabled layers cannot introduce or override configuration", () => {
  assert.deepEqual(readConfig([
    layer("on", 0, { x: 1 }), layer("off", 9, { x: 9, hidden: true }, false),
  ]), { config: { x: 1 }, keys: ["x"] });
});

test("priority then id determines winners independently of input order", () => {
  const layers = [layer("z", 2, { x: 3 }), layer("a", 2, { x: 2 }), layer("low", 1, { x: 1 })];
  for (const order of [layers, [...layers].reverse(), [layers[1], layers[0], layers[2]]]) {
    assert.deepEqual(resolveConfig(order), { x: 3 });
  }
});

test("undefined and null deliberately overwrite earlier values without cloning value references", () => {
  const reference = Object.freeze({ nested: true });
  const low = Object.freeze({ x: 1, y: 2, reference });
  const high = Object.freeze({ x: undefined, y: null });
  const layers = Object.freeze([Object.freeze(layer("high", 2, high)), Object.freeze(layer("low", 1, low))]);
  const result = resolveConfig(layers);
  assert.deepEqual(result, { x: undefined, y: null, reference });
  assert.ok(Object.hasOwn(result, "x"));
  assert.strictEqual(result.reference, reference);
  assert.deepEqual(low, { x: 1, y: 2, reference });
  assert.deepEqual(high, { x: undefined, y: null });
});

test("all own string keys including __proto__ stay data properties without changing the prototype", () => {
  const payload = { polluted: true };
  const values = { ["__proto__"]: payload, constructor: "own", toString: null, "2": 2, "10": 10 };
  Object.defineProperty(values, "nonEnumerable", { value: undefined });
  Object.freeze(values);
  const { config, keys } = readConfig([layer("safe", 0, values)]);
  assert.strictEqual(Object.getPrototypeOf(config), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(config, "__proto__"), {
    value: payload, writable: true, enumerable: true, configurable: true,
  });
  assert.ok(Object.hasOwn(config, "nonEnumerable"));
  assert.strictEqual(config.nonEnumerable, undefined);
  assert.strictEqual(config.constructor, "own");
  assert.strictEqual(config.toString, null);
  assert.strictEqual(config.polluted, undefined);
  assert.deepEqual(keys, ["10", "2", "__proto__", "constructor", "nonEnumerable", "toString"]);
});

test("empty or disabled-only inputs yield fresh empty configs and preserve the caller shape", () => {
  const first = resolveConfig([]);
  const second = resolveConfig([]);
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, {});
  assert.deepEqual(readConfig([layer("off", 0, { x: 1 }, false)]), { config: {}, keys: [] });
  assert.deepEqual(orderedLayers([]), []);
});

test("each resolved config is fresh so consumer writes cannot mutate source values", () => {
  const values = { x: 1 };
  const layers = [layer("one", 0, values)];
  const first = resolveConfig(layers);
  const second = resolveConfig(layers);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first, values);
  first.x = 9;
  assert.deepEqual(second, { x: 1 });
  assert.deepEqual(values, { x: 1 });
});

// 实测证据：node --test test/public.test.mjs test/extra.test.mjs
// 修复前：9 项，2 通过、7 失败，退出码 1。
// 冻结输入实际抛出 Cannot assign to read only property '0'，期望正常返回且输入不变。
// 禁用层实际产生 {x:9,hidden:true}，期望 {x:1}；同优先级覆盖实际 x=1，期望 x=3。
// __proto__ 实际将结果原型改成 payload，期望保持 Object.prototype 并生成自有数据属性。
// 修复：过滤后排序；按 priority 和 JS 字符串 id 比较；逐键定义数据属性安全覆盖。
// 修复后同命令：9 项全部通过，0 失败、0 跳过，退出码 0。
