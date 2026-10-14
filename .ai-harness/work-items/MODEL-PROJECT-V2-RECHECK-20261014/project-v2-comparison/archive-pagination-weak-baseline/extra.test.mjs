import test from "node:test";
import assert from "node:assert/strict";
import { selectVisible } from "../src/repository.mjs";
import { listPage } from "../src/pagination.mjs";
import { fetchPage } from "../src/caller.mjs";
import { MAX_PAGE_SIZE } from "../src/limits.mjs";

// 修复前复现：node --test test/public.test.mjs，1 通过、1 失败。
// 游标 a 后 limit=1：期望 records=[b]、next=null，实际 records=[a]、next=a。
// 根因：在原始集合上含游标切页后才排序，未过滤归档，无参数校验，
// 无条件返回末项游标；repository.sort 还会修改调用方数组。
// 回归意图：先得到不可变的完整可见有序集合，再做排他分页，保留 caller 契约。
const row = (id, updatedAt, archived = false) => ({ id, updatedAt, archived });

test("visible ordering uses JavaScript string order without mutating caller data", () => {
  const rows = [row("z", 2), row("hidden", 0, true), row("a", 1), row("ä", 1), row("Z", 1), row("A", 1)];
  const before = structuredClone(rows);
  const visible = selectVisible(rows);
  assert.deepEqual(visible.map(item => item.id), ["A", "Z", "a", "ä", "z"]);
  assert.deepEqual(rows, before);
  assert.notStrictEqual(visible, rows);
});

test("frozen arrays and records remain valid inputs for both public exports", () => {
  const rows = Object.freeze([Object.freeze(row("b", 2)), Object.freeze(row("a", 1))]);
  assert.deepEqual(selectVisible(rows).map(item => item.id), ["a", "b"]);
  assert.deepEqual(listPage(rows), { items: [rows[1], rows[0]], nextCursor: null });
});

test("complete traversal never repeats, omits or budgets archived rows", () => {
  const rows = [row("d", 3), row("hidden", 1, true), row("b", 1), row("a", 1), row("c", 2), row("hidden-last", 4, true)];
  const before = structuredClone(rows);
  for (const limit of [1, 2, 3, MAX_PAGE_SIZE]) {
    let after = null;
    const seen = [];
    for (let pages = 0; pages < 5; pages++) {
      const page = listPage(rows, { after, limit });
      assert.ok(page.items.length > 0 && page.items.length <= limit);
      seen.push(...page.items.map(item => item.id));
      const remaining = 4 - seen.length;
      assert.equal(page.nextCursor, remaining > 0 ? page.items.at(-1).id : null);
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    assert.deepEqual(seen, ["a", "b", "c", "d"]);
  }
  assert.deepEqual(rows, before);
});

test("empty, archived-only and exhausted pages terminate without a cursor", () => {
  for (const rows of [[], [row("hidden", 0, true)]]) {
    assert.deepEqual(listPage(rows), { items: [], nextCursor: null });
  }
  assert.deepEqual(listPage([row("a", 1)], { after: "a" }), { items: [], nextCursor: null });
});

test("invalid cursors fail loudly rather than restarting or leaking archived data", () => {
  const rows = [row("a", 1), row("hidden", 0, true)];
  for (const after of ["missing", "hidden", "", 0, false, {}, [], new String("a")]) {
    assert.throws(() => listPage(rows, { after }), RangeError);
  }
  assert.throws(() => listPage([], { after: "missing" }), RangeError);
});

test("page-size boundaries reject coercion and prevent unbounded requests", () => {
  for (const limit of [0, -1, 1.5, MAX_PAGE_SIZE + 1, NaN, Infinity, -Infinity, "2", null, true, {}, 1n]) {
    assert.throws(() => listPage([], { limit }), RangeError);
  }
  const rows = Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, i) => row(String(i), i));
  assert.deepEqual(listPage(rows, { limit: MAX_PAGE_SIZE }), { items: rows.slice(0, MAX_PAGE_SIZE), nextCursor: rows[MAX_PAGE_SIZE - 1].id });
  assert.deepEqual(listPage(rows).items, rows.slice(0, 2));
  assert.deepEqual(listPage(rows, { after: undefined, limit: undefined }), listPage(rows));
});

test("caller preserves its projection while filtering before page selection", () => {
  const rows = [row("hidden", 0, true), row("b", 2), row("a", 1)];
  assert.deepEqual(fetchPage(rows, { limit: 1 }), { records: [{ id: "a", updatedAt: 1 }], next: "a" });
  assert.deepEqual(fetchPage(rows, { after: "a", limit: 1 }), { records: [{ id: "b", updatedAt: 2 }], next: null });
});

// 实际验证记录：
// 修复前 node --test test/extra.test.mjs：0 通过、7 失败，退出码 1；
// 包括冻结数组原地排序 TypeError、非法参数未抛 RangeError、归档记录泄漏。
// 修复后 node --test test/public.test.mjs test/extra.test.mjs：9 通过、0 失败、0 跳过，退出码 0。
