import test from "node:test";
import assert from "node:assert/strict";
import { selectVisible } from "../src/repository.mjs";
import { listPage } from "../src/pagination.mjs";
import { fetchPage } from "../src/caller.mjs";
import { MAX_PAGE_SIZE } from "../src/limits.mjs";

// 修复前公共测试实测：2 项中 1 失败，after:"a",limit:1
// 期望 {records:[{id:"b",updatedAt:2}],next:null}；实际返回 a 且 next:"a"。
// 根因：在原始数组先切页、游标包含自身；仓储原地排序且未过滤、未按 id 破同值；末页无剩余判断。
const row = (id, updatedAt = 1, archived = false) => ({ id, updatedAt, archived });

test("仓储过滤后按时间和 JavaScript 字符串顺序排序，不更改调用方数据", () => {
  const records = [row("z", 2), row("ä"), row("a"), row("hidden", 0, true), row("Z"), row("A")];
  const before = structuredClone(records);
  assert.deepEqual(selectVisible(records).map(r => r.id), ["A", "Z", "a", "ä", "z"]);
  assert.deepEqual(records, before);
  records.forEach(Object.freeze);
  Object.freeze(records);
  assert.deepEqual(selectVisible(records).map(r => r.id), ["A", "Z", "a", "ä", "z"]);
});

test("完整遍历不得重复遗漏或让归档行占页，且调用方契约不变", () => {
  const records = [row("d", 3), row("hidden", 0, true), row("b"), row("a"), row("c", 2), row("hidden2", 2, true)];
  const before = structuredClone(records);
  for (const limit of [1, 2, 3, MAX_PAGE_SIZE]) {
    let after = null;
    const ids = [];
    for (let count = 0; count < 5; count++) {
      const page = fetchPage(records, { after, limit });
      assert.ok(page.records.length > 0 && page.records.length <= limit);
      for (const item of page.records) assert.deepEqual(Object.keys(item), ["id", "updatedAt"]);
      ids.push(...page.records.map(r => r.id));
      if (page.next === null) break;
      assert.equal(page.next, page.records.at(-1).id);
      after = page.next;
    }
    assert.deepEqual(ids, ["a", "b", "c", "d"]);
  }
  assert.deepEqual(records, before);
});

test("默认页大小、恰好满页的末页和末条游标都正确终止", () => {
  const records = [row("c", 3), row("a"), row("b", 2)];
  assert.deepEqual(listPage(records), { items: [records[1], records[2]], nextCursor: "b" });
  assert.deepEqual(listPage(records, { after: "a" }), { items: [records[2], records[0]], nextCursor: null });
  assert.deepEqual(listPage(records, { after: "c" }), { items: [], nextCursor: null });
  assert.deepEqual(listPage([], {}), { items: [], nextCursor: null });
  assert.deepEqual(listPage([row("hidden", 0, true)]), { items: [], nextCursor: null });
});

test("无效大小必须明确拒绝，不能隐式截断或转换", () => {
  for (const limit of [0, -1, 1.5, MAX_PAGE_SIZE + 1, NaN, Infinity, -Infinity, "2", null, true, {}, 1n]) {
    assert.throws(() => listPage([], { limit }), RangeError);
  }
  const records = Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, i) => row(String(i), i));
  const page = listPage(records, { limit: MAX_PAGE_SIZE });
  assert.equal(page.items.length, MAX_PAGE_SIZE);
  assert.equal(page.nextCursor, String(MAX_PAGE_SIZE - 1));
  assert.deepEqual(listPage(records, { after: page.nextCursor, limit: MAX_PAGE_SIZE }), { items: [records.at(-1)], nextCursor: null });
});

test("未知、归档和非字符串游标不能退化为错误的成功页", () => {
  const records = [row("a"), row("hidden", 0, true)];
  for (const after of ["unknown", "hidden", "", 0, false, {}, [], 1n, Symbol("a")]) {
    assert.throws(() => listPage(records, { after }), RangeError);
  }
  assert.throws(() => listPage([], { after: "a" }), RangeError);
});
// 验证记录：修复前公共测试 1/2 通过、新增测试 0/5 通过；修复后联合回归 7/7 通过，无跳过。
