import test from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/reconcile.mjs";
import { sync } from "../src/caller.mjs";

const upsert = (id, version, value = null) => ({ id, version, type: "upsert", value });
const deleted = (id, version) => ({ id, version, deleted: true });
const live = (id, version, value = null) => ({ id, version, deleted: false, value });

test("tombstones prevent stale resurrection, ties preserve the first winner, and replay is idempotent", () => {
  const current = [live("a", 3, "existing")];
  const events = [upsert("a", 3, "tie"), { id: "b", version: 2, type: "delete" },
    upsert("b", 1), upsert("b", 2), upsert("c", 0, "first"),
    { id: "c", version: 0, type: "delete" }];
  const result = [live("a", 3, "existing"), deleted("b", 2), live("c", 0, "first")];
  assert.deepEqual(reconcile(current, events), result);
  assert.deepEqual(reconcile(result, events), result);
  assert.deepEqual(reconcile(result, [upsert("b", 3, false)]),
    [result[0], live("b", 3, false), result[2]]);
});

test("arbitrary ids remain independent and use JavaScript string ordering, not numeric or locale ordering", () => {
  const ids = ["__proto__", "constructor", "toString", "2", "10", "a", "A", "😀", "\uffff"];
  assert.deepEqual(reconcile([], ids.map(id => upsert(id, 0))).map(row => row.id), [...ids].sort());
});

test("normalization and caller visibility preserve frozen inputs and discard extra record fields", () => {
  const value = Object.freeze({ nested: Object.freeze([null, false, 0, ""]) });
  const current = Object.freeze([
    Object.freeze({ ...live("z", 1, value), extra: true }),
    Object.freeze({ ...deleted("a", 2), value: "discard" })
  ]);
  const events = Object.freeze([Object.freeze(upsert("b", Number.MAX_SAFE_INTEGER, value))]);
  const before = JSON.stringify([current, events]);
  const expected = [deleted("a", 2), live("b", Number.MAX_SAFE_INTEGER, value), live("z", 1, value)];
  assert.deepEqual(sync(current, events), { records: expected, visible: expected.slice(1) });
  assert.equal(JSON.stringify([current, events]), before);
  assert.notEqual(reconcile(current, [])[1], current[0]);
});

test("invalid containers, holes and duplicate snapshots reject the entire call", () => {
  for (const invalid of [null, {}, "", new Array(1), [undefined]]) {
    assert.throws(() => reconcile(invalid, []), TypeError);
    assert.throws(() => reconcile([], invalid), TypeError);
  }
  assert.throws(() => reconcile([live("a", 0), deleted("a", 1)], []), TypeError);
});

test("invalid fields and missing own values cannot silently corrupt accepted state", () => {
  for (const patch of [{ id: "" }, { id: 1 }, { version: -1 }, { version: 0.5 },
    { version: NaN }, { version: Infinity }, { version: Number.MAX_SAFE_INTEGER + 1 }, { version: "1" }]) {
    assert.throws(() => reconcile([{ ...live("a", 0), ...patch }], []), TypeError);
    assert.throws(() => reconcile([], [{ ...upsert("a", 0), ...patch }]), TypeError);
  }
  for (const row of [null, [], {}, { id: "a", version: 0, deleted: 0 }, { id: "a", version: 0, deleted: false }]) {
    assert.throws(() => reconcile([row], []), TypeError);
  }
  for (const event of [{ ...upsert("a", 0), type: "other" }, { id: "a", version: 0, type: "upsert" },
    Object.assign(Object.create({ value: 1 }), { id: "a", version: 0, type: "upsert" })]) {
    assert.throws(() => reconcile([live("a", 5)], [upsert("b", 1), event]), TypeError);
  }
});

test("JSON validation rejects lossy or cyclic values but permits shared subobjects", () => {
  const cycle = {}; cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, 1n, Symbol(), () => {}, { a: undefined }, [undefined], new Array(1), cycle, new Date()]) {
    assert.throws(() => reconcile([], [upsert("a", 0, value === undefined ? null : value),
      { id: "b", version: 0, type: "upsert", value }]), TypeError);
    assert.throws(() => reconcile([live("a", 0, null), { ...live("b", 0), value }], []), TypeError);
  }
  const shared = { valid: [1, null, true] };
  const value = { left: shared, right: shared };
  assert.deepEqual(reconcile([], [upsert("a", 0, value)]), [live("a", 0, value)]);
});
