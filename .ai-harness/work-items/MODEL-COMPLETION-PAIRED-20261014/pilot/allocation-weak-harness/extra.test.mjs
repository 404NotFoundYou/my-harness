import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.mjs";
import { invoice } from "../src/caller.mjs";

const max = Number.MAX_SAFE_INTEGER;

test("largest remainders conserve the total; ties favor the original index", () => {
  assert.deepEqual(allocate(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocate(7, [1, 2, 3]), [1, 2, 4]);
  assert.deepEqual(allocate(1, [0, 1, 1]), [0, 1, 0]);
  assert.deepEqual(allocate(0, [1, 0, 2]), [0, 0, 0]);
});

test("exact arithmetic preserves allocations when sums and products exceed safe integers", () => {
  assert.deepEqual(allocate(max, [max, max]), [4503599627370496, 4503599627370495]);
  assert.deepEqual(allocate(1, [max - 1, max]), [0, 1]);
  assert.deepEqual(allocate(max, [0, max, 0]), [0, max, 0]);
  assert.deepEqual(allocate(max, [max]), [max]);
});

test("zero weight totals are defined only for zero allocation", () => {
  assert.deepEqual(allocate(0, [0, 0]), [0, 0]);
  assert.throws(() => allocate(1, [0, 0]), RangeError);
});

test("invalid inputs fail explicitly rather than coercing or skipping weights", () => {
  const invalid = [-1, 0.5, max + 1, NaN, Infinity, -Infinity, "1", null, undefined, true, 1n, {}, Symbol("weight")];
  for (const value of invalid) {
    assert.throws(() => allocate(value, [1]), RangeError);
    assert.throws(() => allocate(0, [value]), RangeError);
  }
  for (const weights of [[], null, undefined, {}, "12", new Uint8Array([1]), new Array(2), [1, , 2]]) {
    assert.throws(() => allocate(0, weights), RangeError);
  }
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, { 0: 1 });
  assert.throws(() => allocate(1, inherited), RangeError);
});

test("allocation does not mutate frozen inputs and invoice preserves line data and order", () => {
  const weights = Object.freeze([3, 1, 2]);
  assert.deepEqual(allocate(5, weights), [2, 1, 2]);
  assert.deepEqual(weights, [3, 1, 2]);
  const lines = Object.freeze([Object.freeze({ id: "a", weight: 1 }), Object.freeze({ id: "b", weight: 1 })]);
  assert.deepEqual(invoice(1, lines), [{ id: "a", weight: 1, amount: 1 }, { id: "b", weight: 1, amount: 0 }]);
  assert.equal(Object.hasOwn(lines[0], "amount"), false);
});

test("small exhaustive cases enforce conservation, quota, zero weights and remainder priority", () => {
  for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) for (let c = 0; c <= 4; c++) {
    const weights = [a, b, c];
    const sum = a + b + c;
    if (sum === 0) continue;
    for (let total = 0; total <= 15; total++) {
      const result = allocate(total, weights);
      const floors = weights.map(w => Math.floor(total * w / sum));
      const winners = [];
      const losers = [];
      assert.equal(result.reduce((s, n) => s + n, 0), total);
      result.forEach((n, i) => {
        assert.ok(Number.isSafeInteger(n) && n >= 0);
        if (weights[i] === 0) assert.equal(n, 0);
        assert.ok(n === floors[i] || n === floors[i] + 1);
        (n > floors[i] ? winners : losers).push(i);
      });
      for (const i of winners) for (const j of losers) {
        const ri = total * weights[i] % sum;
        const rj = total * weights[j] % sum;
        assert.ok(ri > rj || (ri === rj && i < j));
      }
    }
  }
});
