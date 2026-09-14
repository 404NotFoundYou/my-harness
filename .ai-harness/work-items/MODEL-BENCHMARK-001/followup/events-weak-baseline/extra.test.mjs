import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.mjs";
import { sync } from "../src/caller.mjs";

test("reconciles versions and retains tombstones so older events cannot resurrect deleted data", () => {
  const actual = reconcile(
    [{ id: "gone", version: 4, deleted: true }, { id: "keep", version: 2, deleted: false, value: "old" }],
    [
      { id: "gone", version: 3, type: "upsert", value: "stale" },
      { id: "keep", version: 2, type: "upsert", value: "tie loses to snapshot" },
      { id: "tie", version: 3, type: "delete" },
      { id: "tie", version: 3, type: "upsert", value: "tie loses to first event" },
      { id: "new", version: 0, type: "upsert", value: { ok: [null, true] } },
      { id: "keep", version: 3, type: "delete" },
      { id: "keep", version: 3, type: "upsert", value: "tie loses to deletion" },
      { id: "keep", version: 4, type: "upsert", value: "newer wins" },
    ],
  );

  assert.deepEqual(actual, [
    { id: "gone", version: 4, deleted: true },
    { id: "keep", version: 4, deleted: false, value: "newer wins" },
    { id: "new", version: 0, deleted: false, value: { ok: [null, true] } },
    { id: "tie", version: 3, deleted: true },
  ]);
});

test("uses JavaScript string ordering, normalizes output fields, and leaves inputs untouched", () => {
  const current = [{ id: "a", version: 1, deleted: false, value: 2, ignored: "field" }];
  const events = [{ id: "Z", version: 1, type: "upsert", value: [1, { x: "y" }] }];
  const currentBefore = structuredClone(current);
  const eventsBefore = structuredClone(events);
  const first = reconcile(current, events);

  assert.deepEqual(first.map(row => row.id), ["Z", "a"]);
  assert.deepEqual(first[1], { id: "a", version: 1, deleted: false, value: 2 });
  assert.deepEqual(current, currentBefore);
  assert.deepEqual(events, eventsBefore);
  assert.deepEqual(reconcile(first, events), first);
});

test("caller keeps tombstones available while excluding deleted records from visible results", () => {
  const result = sync(
    [{ id: "item", version: 1, deleted: false, value: "visible" }],
    [{ id: "item", version: 2, type: "delete" }],
  );
  assert.deepEqual(result.records, [{ id: "item", version: 2, deleted: true }]);
  assert.deepEqual(result.visible, []);
});

test("rejects malformed arrays, records, and values instead of returning partial state", () => {
  const sparse = [];
  sparse.length = 1;
  const cyclic = {};
  cyclic.self = cyclic;
  const invalidCalls = [
    () => reconcile(null, []),
    () => reconcile(sparse, []),
    () => reconcile([], sparse),
    () => reconcile([{ id: "x", version: 0, deleted: false }], []),
    () => reconcile([{ id: "x", version: -1, deleted: true }], []),
    () => reconcile([{ id: "x", version: 0, deleted: true }, { id: "x", version: 1, deleted: true }], []),
    () => reconcile([], [{ id: "x", version: 0, type: "upsert" }]),
    () => reconcile([], [{ id: "x", version: Number.MAX_SAFE_INTEGER + 1, type: "delete" }]),
    () => reconcile([], [{ id: "x", version: 0, type: "upsert", value: undefined }]),
    () => reconcile([], [{ id: "x", version: 0, type: "upsert", value: Number.NaN }]),
    () => reconcile([], [{ id: "x", version: 0, type: "upsert", value: cyclic }]),
  ];

  for (const call of invalidCalls) assert.throws(call, TypeError);
});
