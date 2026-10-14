import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.mjs";
import { sync } from "../src/caller.mjs";

const live = (id, version, value = null) => ({ id, version, deleted: false, value });
const upsert = (id, version, value = null) => ({ id, version, type: "upsert", value });
const remove = (id, version) => ({ id, version, type: "delete" });

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("newer versions win while equal versions preserve existing or first-arriving data", () => {
  assert.deepEqual(reconcile([live("a", 3, "existing")], [
    upsert("a", 2, "old"), remove("a", 3), upsert("b", 0, "first"),
    remove("b", 0), upsert("a", 4, "new"), upsert("a", 4, "equal")
  ]), [live("a", 4, "new"), live("b", 0, "first")]);
});

test("tombstones prevent stale resurrection but allow a newer upsert", () => {
  const events = [remove("a", 5), upsert("a", 4), upsert("a", 5), remove("b", 0)];
  const result = reconcile([], events);
  assert.deepEqual(result, [{ id: "a", version: 5, deleted: true }, { id: "b", version: 0, deleted: true }]);
  assert.deepEqual(reconcile(result, events), result);
  assert.deepEqual(reconcile(result, [upsert("a", 6, false)]), [live("a", 6, false), result[1]]);
});

test("arbitrary ids remain safe and use JavaScript string order rather than numeric or locale order", () => {
  const ids = ["2", "10", "__proto__", "constructor", "toString", "é", "Z", "a", "😀", "\uffff"];
  assert.deepEqual(reconcile([], ids.map(id => upsert(id, 0))).map(row => row.id), [...ids].sort());
});

test("pure reconciliation strips extra fields without changing input and keeps caller visibility compatible", () => {
  const current = freeze([{ ...live("z", 0, { nested: [null, true, 3, "x"] }), extra: 1 }, { id: "a", version: 2, deleted: true, value: "discard", extra: 2 }]);
  const events = freeze([upsert("b", 1, []), remove("z", 1)]);
  const before = JSON.stringify({ current, events });
  const expected = [{ id: "a", version: 2, deleted: true }, live("b", 1, []), { id: "z", version: 1, deleted: true }];
  assert.deepEqual(sync(current, events), { records: expected, visible: [expected[1]] });
  assert.equal(JSON.stringify({ current, events }), before);
  const copy = reconcile(current, []);
  assert.notEqual(copy[1], current[0]);
  assert.deepEqual(Object.keys(copy[0]), ["id", "version", "deleted"]);
});

test("all malformed records fail even when an event would otherwise be ignored as stale", () => {
  const invalidIdentity = [null, undefined, 1, "a", [], {}, { id: "", version: 0 },
    ...[null, 1, false].map(id => ({ id, version: 0 })),
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"].map(version => ({ id: "a", version }))];
  for (const row of invalidIdentity) {
    assert.throws(() => reconcile([row], []), TypeError);
    assert.throws(() => reconcile([], [row]), TypeError);
  }
  for (const row of [{ id: "a", version: 0, deleted: 0 }, { id: "a", version: 0, deleted: false }]) {
    assert.throws(() => reconcile([row], []), TypeError);
  }
  for (const event of [{ id: "a", version: 0, type: "other" }, { id: "a", version: 0, type: "upsert" }]) {
    assert.throws(() => reconcile([live("a", 9)], [event]), TypeError);
  }
  const inherited = Object.assign(Object.create({ value: 1 }), { id: "a", version: 0, type: "upsert", deleted: false });
  assert.throws(() => reconcile([], [inherited]), TypeError);
  assert.throws(() => reconcile([inherited], []), TypeError);
});

test("dense arrays and unique snapshot ids are mandatory to avoid silently losing records", () => {
  for (const input of [null, {}, "", new Array(1)]) {
    assert.throws(() => reconcile(input, []), TypeError);
    assert.throws(() => reconcile([], input), TypeError);
  }
  assert.throws(() => reconcile([live("a", 0), { id: "a", version: 1, deleted: true }], []), TypeError);
  assert.deepEqual(reconcile([], []), []);
});

test("JSON payload validation rejects invalid nested data and cycles but permits shared subobjects", () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol("x"), new Date(), new Map(), cycle, [undefined], new Array(1), { child: undefined }]) {
    assert.throws(() => reconcile([], [{ id: "a", version: 0, type: "upsert", value }]), TypeError);
    assert.throws(() => reconcile([{ id: "a", version: 0, deleted: false, value }], []), TypeError);
  }
  const shared = { a: 1 };
  for (const value of [null, false, 0, "", [], {}, { a: shared, b: shared }, Object.create(null)]) {
    assert.deepEqual(reconcile([], [upsert("a", Number.MAX_SAFE_INTEGER, value)]), [live("a", Number.MAX_SAFE_INTEGER, value)]);
  }
});

test("late validation failures do not partially alter inputs", () => {
  const current = freeze([live("a", 0, "original")]);
  const events = freeze([upsert("a", 1, "replacement"), { id: "b", version: -1, type: "delete" }]);
  assert.throws(() => reconcile(current, events), TypeError);
  assert.deepEqual(current, [live("a", 0, "original")]);
});

test("optional delete payloads must be JSON and never leak into tombstones", () => {
  assert.throws(() => reconcile([], [{ ...remove("a", 1), value: undefined }]), TypeError);
  assert.throws(() => reconcile([{ id: "a", version: 1, deleted: true, value: NaN }], []), TypeError);
  assert.deepEqual(reconcile([], [{ ...remove("a", 1), value: { ignored: true } }]), [{ id: "a", version: 1, deleted: true }]);
});
