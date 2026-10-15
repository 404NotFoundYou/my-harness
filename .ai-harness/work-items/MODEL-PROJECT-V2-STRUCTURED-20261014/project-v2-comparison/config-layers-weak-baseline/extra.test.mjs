import test from "node:test";
import assert from "node:assert/strict";
import { orderedLayers } from "../src/layers.mjs";
import { resolveConfig } from "../src/config.mjs";
import { readConfig } from "../src/caller.mjs";

// 修复前公共复现：node --test test/public.test.mjs，1 通过 / 1 失败；x 实际 1，期望 2。
// 扩展复现：node --test test/public.test.mjs test/extra.test.mjs，修复前 1 通过 / 7 失败。
// 实际失败包括冻结数组排序 TypeError、禁用层泄漏、覆盖值错误及结果原型被替换。
// 修复后同命令 8 通过 / 0 失败 / 0 跳过；断言保留各项期望作为回归证据。
// 根因：合并绕过排序；排序原地修改输入且缺少 enabled 过滤和 id 决胜；
// Object.assign 对 __proto__ 触发继承 setter，不能保留该自有数据键。
const layer = (id, priority, values = {}, enabled = true) => ({id, priority, enabled, values});

test("ordering filters disabled layers and uses JS id order without changing frozen inputs", () => {
  const layers = Object.freeze([
    layer("z", 1), layer("off", 0, {}, false), layer("a", 1),
    layer("A", 1), layer("first", 0), layer("last", Number.MAX_SAFE_INTEGER),
    layer("\uE000", 1), layer("\u{10000}", 1)
  ].map(value => Object.freeze({...value, values: Object.freeze(value.values)})));
  const before = [...layers];
  const ordered = orderedLayers(layers);
  assert.deepEqual(ordered.map(value => value.id), ["first", "A", "a", "z", "\u{10000}", "\uE000", "last"]);
  assert.deepEqual(layers, before);
  assert.notStrictEqual(ordered, layers);
  for (const value of ordered) assert.ok(layers.includes(value));
});

test("disabled values cannot leak even when they come last", () => {
  assert.deepEqual(readConfig([layer("on", 0, {x: 1}), layer("off", 10, {x: 9, secret: true}, false)]), {config: {x: 1}, keys: ["x"]});
});

test("priority and id determine winners independently of input order; null and undefined override", () => {
  const reference = {nested: true};
  const layers = [layer("b", 2, {x: undefined, y: null, reference}), layer("a", 2, {x: 2, y: 2}), layer("base", 0, {x: 0, y: 0})];
  for (const input of [layers, [...layers].reverse(), [layers[1], layers[0], layers[2]]]) {
    const result = readConfig(input);
    assert.deepEqual(result, {config: {x: undefined, y: null, reference}, keys: ["reference", "x", "y"]});
    assert.ok(Object.hasOwn(result.config, "x"));
    assert.strictEqual(result.config.reference, reference);
  }
});

test("all own string keys are preserved as data without invoking the prototype setter", () => {
  const prototypeValue = {polluted: true};
  const values = { ["__proto__"]: prototypeValue, constructor: "data", toString: null, "10": 10, "2": 2 };
  Object.defineProperty(values, "hidden", {value: undefined, enumerable: false});
  Object.freeze(values);
  const layers = Object.freeze([Object.freeze(layer("safe", 0, values))]);
  const before = Object.getOwnPropertyDescriptors(values);
  const {config, keys} = readConfig(layers);
  assert.strictEqual(Object.getPrototypeOf(config), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(config, "__proto__"), {value: prototypeValue, writable: true, enumerable: true, configurable: true});
  assert.deepEqual(keys, ["10", "2", "__proto__", "constructor", "hidden", "toString"]);
  assert.ok(Object.hasOwn(config, "hidden"));
  assert.strictEqual(config.hidden, undefined);
  assert.strictEqual(config.constructor, "data");
  assert.strictEqual(config.toString, null);
  assert.deepEqual(Object.getOwnPropertyDescriptors(values), before);
  assert.notStrictEqual(config, values);
  const overridden = resolveConfig([...layers, layer("later", 1, {["__proto__"]: null})]);
  assert.strictEqual(overridden.__proto__, null);
  assert.strictEqual(Object.getPrototypeOf(overridden), Object.prototype);
});

test("empty and disabled-only inputs produce fresh empty results", () => {
  for (const layers of [[], [layer("off", 0, {x: 1}, false)]]) {
    assert.deepEqual(orderedLayers(layers), []);
    const first = resolveConfig(layers);
    assert.deepEqual(first, {});
    assert.notStrictEqual(first, resolveConfig(layers));
    assert.deepEqual(readConfig(layers), {config: {}, keys: []});
  }
});

test("sorting and merging preserve mutable input order and value descriptors", () => {
  const layers = [layer("higher", 2, {x: 2}), layer("lower", 1, {x: 1})];
  const before = [...layers];
  const descriptors = layers.map(value => Object.getOwnPropertyDescriptors(value.values));
  orderedLayers(layers);
  assert.deepEqual(layers, before);
  const first = resolveConfig(layers);
  first.x = 99;
  assert.deepEqual(resolveConfig(layers), {x: 2});
  assert.deepEqual(layers, before);
  assert.deepEqual(layers.map(value => Object.getOwnPropertyDescriptors(value.values)), descriptors);
});
