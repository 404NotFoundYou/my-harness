import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.mjs";
import { sync } from "../src/caller.mjs";

test("only newer versions apply, and the first record wins version ties", () => {
  const result = reconcile(
    [{ id: "a", version: 4, deleted: false, value: "current", ignored: true }],
    [
      { id: "a", version: 3, type: "upsert", value: "stale" },
      { id: "a", version: 5, type: "upsert", value: "first" },
      { id: "a", version: 5, type: "delete" },
    ],
  );
  assert.deepEqual(result, [{ id: "a", version: 5, deleted: false, value: "first" }]);
});

test("a tombstone blocks stale resurrection and repeated events are idempotent", () => {
  const events = [
    { id: "item", version: 8, type: "delete" },
    { id: "item", version: 7, type: "upsert", value: "old" },
  ];
  const first = reconcile([], events);
  assert.deepEqual(first, [{ id: "item", version: 8, deleted: true }]);
  assert.deepEqual(reconcile(first, events), first);
  assert.deepEqual(sync([], events), { records: first, visible: [] });
});

test("output is string-sorted, normalized, and does not reorder or mutate inputs", () => {
  const current = Object.freeze([
    Object.freeze({ id: "z", version: 1, deleted: true, value: "discard", extra: 1 }),
    Object.freeze({ id: "2", version: 1, deleted: false, value: null, extra: 2 }),
  ]);
  const events = Object.freeze([
    Object.freeze({ id: "10", version: 0, type: "upsert", value: { nested: [true, null] } }),
  ]);
  const beforeCurrent = structuredClone(current);
  const beforeEvents = structuredClone(events);

  assert.deepEqual(reconcile(current, events), [
    { id: "10", version: 0, deleted: false, value: { nested: [true, null] } },
    { id: "2", version: 1, deleted: false, value: null },
    { id: "z", version: 1, deleted: true },
  ]);
  assert.deepEqual(current, beforeCurrent);
  assert.deepEqual(events, beforeEvents);
});

test("all inputs are validated before processing, preventing partial results", () => {
  const current = [{ id: "a", version: 1, deleted: false, value: "keep" }];
  const events = [
    { id: "a", version: 2, type: "delete" },
    { id: "b", version: 3, type: "upsert" },
  ];
  const beforeCurrent = structuredClone(current);
  const beforeEvents = structuredClone(events);

  assert.throws(() => reconcile(current, events), TypeError);
  assert.deepEqual(current, beforeCurrent);
  assert.deepEqual(events, beforeEvents);
});

test("malformed records, duplicate current ids, and sparse arrays are rejected", () => {
  assert.throws(() => reconcile([
    { id: "a", version: 0, deleted: false, value: 1 },
    { id: "a", version: 1, deleted: true },
  ], []), TypeError);
  assert.throws(() => reconcile([], [{ id: "", version: 0, type: "delete" }]), TypeError);
  assert.throws(() => reconcile([], [{ id: "a", version: -1, type: "delete" }]), TypeError);
  assert.throws(() => reconcile([], [{ id: "a", version: 0, type: "upsert" }]), TypeError);
  assert.throws(() => reconcile(new Array(1), []), TypeError);
  assert.throws(() => reconcile([], new Array(1)), TypeError);
  assert.throws(() => reconcile([], [{ id: "a", version: 0, type: "upsert", value: [,] }]), TypeError);
});
