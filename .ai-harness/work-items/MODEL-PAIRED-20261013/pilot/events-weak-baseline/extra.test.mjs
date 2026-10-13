import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.mjs";
import { sync } from "../src/caller.mjs";

const upsert = (id, version, value) => ({ id, version, type: "upsert", value });
const remove = (id, version) => ({ id, version, type: "delete" });

test("newer versions win, ties preserve existing or first-arriving state", () => {
  assert.deepEqual(reconcile([{ id: "a", version: 2, deleted: false, value: "snapshot" }], [
    upsert("a", 2, "tie"), remove("a", 1), upsert("b", 3, "first"),
    remove("b", 3), upsert("b", 2, "older"), upsert("a", 4, "new")
  ]), [
    { id: "a", version: 4, deleted: false, value: "new" },
    { id: "b", version: 3, deleted: false, value: "first" }
  ]);
});

test("tombstones block stale resurrection, but allow a newer upsert", () => {
  const events = [remove("a", 4), upsert("a", 3, "stale"), upsert("a", 4, "tie")];
  const result = reconcile([], events);
  assert.deepEqual(result, [{ id: "a", version: 4, deleted: true }]);
  assert.deepEqual(reconcile(result, events), result);
  assert.deepEqual(reconcile(result, [upsert("a", 5, null)]), [
    { id: "a", version: 5, deleted: false, value: null }
  ]);
  assert.deepEqual(sync([], events), { records: result, visible: [] });
  assert.equal(sync(result, [upsert("a", 5, false)]).visible.length, 1);
});

test("arbitrary ids use string comparison rather than numeric or locale sorting", () => {
  const ids = ["2", "10", "__proto__", "constructor", "toString", "a", "A", "😀", "\uffff"];
  const result = reconcile([], ids.map(id => upsert(id, 0, id)));
  assert.deepEqual(result.map(row => row.id), [...ids].sort());
  assert.equal(result.length, ids.length);
});

test("output strips unrelated fields without mutating frozen inputs", () => {
  const value = Object.freeze({ nested: Object.freeze([null, true, 1, "x"]) });
  const current = Object.freeze([
    Object.freeze({ id: "z", version: 0, deleted: false, value, extra: 1 }),
    Object.freeze({ id: "a", version: 2, deleted: true, value: "discard", extra: 1 })
  ]);
  const events = Object.freeze([Object.freeze(upsert("z", 1, value))]);
  const before = JSON.stringify({ current, events });
  const result = reconcile(current, events);
  assert.deepEqual(result, [{ id: "a", version: 2, deleted: true },
    { id: "z", version: 1, deleted: false, value }]);
  assert.notEqual(result[0], current[1]);
  assert.equal(JSON.stringify({ current, events }), before);
  assert.deepEqual(reconcile(result, events), result);
});

test("invalid containers, sparse arrays and duplicate snapshots fail atomically", () => {
  const row = { id: "a", version: 0, deleted: false, value: 1 };
  for (const [current, events] of [[null, []], [[], {}], [new Array(1), []],
    [[], new Array(1)], [[row, { ...row, version: 1 }], []]]) {
    assert.throws(() => reconcile(current, events), TypeError);
  }
  const current = [row];
  const events = [upsert("a", 2, "new"), null];
  const before = JSON.stringify({ current, events });
  assert.throws(() => reconcile(current, events), TypeError);
  assert.equal(JSON.stringify({ current, events }), before);
});

test("all record fields are validated, including stale events", () => {
  const badFields = [null, [], {}, { id: "", version: 0 }, { id: 1, version: 0 },
    ...[-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1"].map(version => ({ id: "a", version }))];
  for (const bad of badFields) {
    assert.throws(() => reconcile([bad], []), TypeError);
    assert.throws(() => reconcile([], [bad]), TypeError);
  }
  for (const bad of [{ id: "a", version: 0, deleted: 0 },
    { id: "a", version: 0, deleted: false },
    Object.assign(Object.create({ value: 1 }), { id: "a", version: 0, deleted: false })]) {
    assert.throws(() => reconcile([bad], []), TypeError);
  }
  const snapshot = [{ id: "a", version: 10, deleted: true }];
  for (const bad of [{ id: "a", version: 0, type: "unknown" },
    { id: "a", version: 0, type: "upsert" },
    Object.assign(Object.create({ value: 1 }), { id: "a", version: 0, type: "upsert" })]) {
    assert.throws(() => reconcile(snapshot, [bad]), TypeError);
  }
});

test("JSON validation rejects invalid nested values and cycles, not shared subtrees", () => {
  const cycle = {}; cycle.self = cycle;
  const invalid = [undefined, NaN, Infinity, -Infinity, 1n, Symbol("x"), () => {},
    new Date(), new Map(), new Set(), cycle, [undefined], new Array(1), { nested: undefined }];
  for (const value of invalid) {
    assert.throws(() => reconcile([], [upsert("a", 0, value)]), TypeError);
    assert.throws(() => reconcile([{ id: "a", version: 0, deleted: false, value }], []), TypeError);
  }
  const shared = { x: 1 };
  for (const value of [null, false, 0, "", [], {}, { a: shared, b: shared }, Object.create(null)]) {
    assert.deepEqual(reconcile([], [upsert("a", Number.MAX_SAFE_INTEGER, value)]), [
      { id: "a", version: Number.MAX_SAFE_INTEGER, deleted: false, value }
    ]);
  }
});
