import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.mjs";
import { sync } from "../src/caller.mjs";

const upsert = (id, version, value) => ({ id, version, type: "upsert", value });
const deleted = (id, version) => ({ id, version, type: "delete" });

test("versions and tombstones prevent stale events from resurrecting deleted data", () => {
  const current = [{ id: "a", version: 2, deleted: false, value: "existing" }];
  const events = [upsert("a", 2, "tie"), deleted("a", 1), deleted("a", 3), upsert("a", 3, "tie"), upsert("a", 0, "old"), deleted("b", 0)];
  const result = reconcile(current, events);
  assert.deepEqual(result, [{ id: "a", version: 3, deleted: true }, { id: "b", version: 0, deleted: true }]);
  assert.deepEqual(reconcile(result, events), result);
  assert.deepEqual(reconcile(result, [upsert("a", 4, null)]), [{ id: "a", version: 4, deleted: false, value: null }, result[1]]);
  assert.deepEqual(reconcile(current, [upsert("a", 2, "tie")]), current);
  assert.equal(reconcile([], [upsert("a", 0, "first"), upsert("a", 0, "second")])[0].value, "first");
});

test("arbitrary ids use string ordering and never act as object properties", () => {
  const ids = ["2", "10", "__proto__", "constructor", "toString", "a", "A", "😀", "\uffff"];
  const result = reconcile([], ids.map(id => upsert(id, 0, id)));
  assert.deepEqual(result.map(row => row.id), [...ids].sort());
  assert.equal(result.length, ids.length);
});

test("canonical output and caller visibility preserve frozen inputs and JSON values", () => {
  const value = Object.freeze({ list: Object.freeze([null, true, 1, "x"]) });
  const current = Object.freeze([Object.freeze({ id: "b", version: 0, deleted: false, value, extra: 1 })]);
  const events = Object.freeze([Object.freeze(deleted("a", 1))]);
  const before = JSON.stringify({ current, events });
  const result = sync(current, events);
  assert.deepEqual(result.records, [{ id: "a", version: 1, deleted: true }, { id: "b", version: 0, deleted: false, value }]);
  assert.deepEqual(result.visible, [result.records[1]]);
  assert.notEqual(result.records[1], current[0]);
  assert.equal(JSON.stringify({ current, events }), before);
  assert.deepEqual(reconcile([{ id: "x", version: 0, deleted: true, value: 1, extra: true }], []), [{ id: "x", version: 0, deleted: true }]);
});

test("invalid records reject the whole call even when their version would be ignored", () => {
  for (const args of [[null, []], [[], {}], [Array(1), []], [[], Array(1)]]) assert.throws(() => reconcile(...args), TypeError);
  for (const row of [null, [], {}, { id: "", version: 0, deleted: true }, { id: 1, version: 0, deleted: true }, ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(version => ({ id: "a", version, deleted: true })), { id: "a", version: 0, deleted: 1 }, { id: "a", version: 0, deleted: false }]) {
    assert.throws(() => reconcile([row], []), TypeError);
  }
  const current = [{ id: "a", version: 5, deleted: true }];
  assert.throws(() => reconcile([...current, ...current], []), TypeError);
  for (const event of [null, {}, { id: "a", version: 0, type: "other" }, { id: "a", version: 0, type: "upsert" }, upsert("a", -1, 1)]) {
    assert.throws(() => reconcile(current, [upsert("b", 1, 1), event]), TypeError);
  }
  const inherited = Object.assign(Object.create({ value: 1 }), { id: "a", version: 0, type: "upsert" });
  assert.throws(() => reconcile(current, [inherited]), TypeError);
  assert.deepEqual(current, [{ id: "a", version: 5, deleted: true }]);
});

test("JSON validation rejects invalid nested data but allows shared noncyclic values", () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, Symbol(), () => {}, cycle, { bad: undefined }, [undefined], Array(1), new Date()]) {
    assert.throws(() => reconcile([], [upsert("a", 0, value)]), TypeError);
    assert.throws(() => reconcile([{ id: "a", version: 0, deleted: false, value }], []), TypeError);
  }
  const shared = { a: 1 };
  const value = { left: shared, right: shared };
  assert.deepEqual(reconcile([], [upsert("a", Number.MAX_SAFE_INTEGER, value)])[0].value, value);
});
