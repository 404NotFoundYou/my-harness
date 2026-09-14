import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.mjs";

test("严格更高版本胜出，同版本保留先存在或先到达的记录", () => {
  const current = [{ id: "a", version: 2, deleted: false, value: "current" }];
  const events = [
    { id: "a", version: 2, type: "delete" },
    { id: "b", version: 1, type: "upsert", value: "first" },
    { id: "b", version: 1, type: "upsert", value: "second" },
    { id: "a", version: 3, type: "upsert", value: "new" },
  ];

  assert.deepEqual(reconcile(current, events), [
    { id: "a", version: 3, deleted: false, value: "new" },
    { id: "b", version: 1, deleted: false, value: "first" },
  ]);
});

test("删除保留墓碑并阻挡较旧更新", () => {
  assert.deepEqual(reconcile([], [
    { id: "a", version: 4, type: "delete" },
    { id: "a", version: 3, type: "upsert", value: "old" },
  ]), [{ id: "a", version: 4, deleted: true }]);
});

test("按 JavaScript 字符串关系排序且不修改输入", () => {
  const current = [
    { id: "a", version: 0, deleted: false, value: null },
    { id: "Z", version: 0, deleted: true },
  ];
  const events = [{ id: "A", version: 0, type: "upsert", value: { nested: [1, true] } }];
  const beforeCurrent = structuredClone(current);
  const beforeEvents = structuredClone(events);

  assert.deepEqual(reconcile(current, events).map(item => item.id), ["A", "Z", "a"]);
  assert.deepEqual(current, beforeCurrent);
  assert.deepEqual(events, beforeEvents);
});

test("重复应用相同事件幂等且输出只含规范字段", () => {
  const current = [{ id: "a", version: 1, deleted: false, value: 1, ignored: true }];
  const events = [{ id: "a", version: 2, type: "delete", value: "ignored", ignored: true }];
  const once = reconcile(current, events);
  assert.deepEqual(reconcile(once, events), once);
  assert.deepEqual(once, [{ id: "a", version: 2, deleted: true }]);
});

test("任一非法输入或重复 current id 均抛出 TypeError", () => {
  const invalidCalls = [
    () => reconcile({}, []),
    () => reconcile([], new Array(1)),
    () => reconcile([{ id: "", version: 0, deleted: true }], []),
    () => reconcile([{ id: "a", version: -1, deleted: true }], []),
    () => reconcile([{ id: "a", version: 0, deleted: false }], []),
    () => reconcile([
      { id: "a", version: 0, deleted: true },
      { id: "a", version: 1, deleted: true },
    ], []),
    () => reconcile([], [{ id: "a", version: 0, type: "upsert" }]),
    () => reconcile([], [{ id: "a", version: 0, type: "other" }]),
    () => reconcile([], [{ id: "a", version: 0, type: "upsert", value: undefined }]),
    () => reconcile([], [{ id: "a", version: 0, type: "upsert", value: NaN }]),
  ];

  for (const call of invalidCalls) assert.throws(call, TypeError);
});
