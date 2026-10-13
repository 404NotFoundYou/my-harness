import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.mjs";
import { invoice } from "../src/caller.mjs";

test("largest remainders conserve units and ties favor the original index", () => {
  assert.deepEqual(allocate(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocate(4, [1, 2, 3]), [1, 1, 2]);
  assert.deepEqual(allocate(1, [0, 1, 1]), [0, 1, 0]);
  assert.deepEqual(allocate(7, [0, 0, 3]), [0, 0, 7]);
});

test("zero totals and zero weights follow the explicit allocation contract", () => {
  assert.deepEqual(allocate(0, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  assert.throws(() => allocate(1, [0, 0]), RangeError);
});

test("invalid numbers, non-arrays and holes cannot silently lose units", () => {
  const invalid = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null, undefined, true, 1n, {}, Symbol("weight")];
  for (const value of invalid) {
    assert.throws(() => allocate(value, [1]), RangeError);
    assert.throws(() => allocate(1, [1, value]), RangeError);
  }
  for (const weights of [[], null, undefined, {}, "12", new Uint8Array([1]), Array(2), [1, , 2]]) {
    assert.throws(() => allocate(1, weights), RangeError);
  }
  const inherited = Array(1);
  Object.setPrototypeOf(inherited, { 0: 1 });
  assert.throws(() => allocate(1, inherited), RangeError);
});

test("safe integer boundary keeps products, sums and close remainder order exact", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(allocate(max, [max, max]), [4503599627370496, 4503599627370495]);
  assert.deepEqual(allocate(max, [max]), [max]);
  assert.deepEqual(allocate(max, [max, 1]), [max - 1, 1]);
  assert.deepEqual(allocate(1, [max - 1, max]), [0, 1]);
  assert.deepEqual(allocate(max, [0, max, 0]), [0, max, 0]);
});

test("caller keeps line order and metadata without mutating frozen inputs", () => {
  const weights = Object.freeze([1, 1, 1]);
  assert.deepEqual(allocate(2, weights), [1, 1, 0]);
  assert.deepEqual(weights, [1, 1, 1]);
  const lines = Object.freeze([Object.freeze({ id: "a", weight: 1 }), Object.freeze({ id: "b", weight: 2 })]);
  assert.deepEqual(invoice(4, lines), [{ id: "a", weight: 1, amount: 1 }, { id: "b", weight: 2, amount: 3 }]);
  assert.equal(Object.hasOwn(lines[0], "amount"), false);
});

test("small exhaustive cases conserve totals and award only the highest exact remainders", () => {
  for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) for (let c = 0; c <= 4; c++) {
    const weights = [a, b, c];
    const sum = a + b + c;
    if (!sum) continue;
    for (let total = 0; total <= 15; total++) {
      const result = allocate(total, weights);
      assert.equal(result.reduce((x, y) => x + y, 0), total);
      for (let i = 0; i < 3; i++) {
        const floor = Math.floor(total * weights[i] / sum);
        assert.ok(result[i] === floor || result[i] === floor + 1);
        if (!weights[i]) assert.equal(result[i], 0);
        if (result[i] === floor) continue;
        for (let j = 0; j < 3; j++) {
          if (result[j] !== Math.floor(total * weights[j] / sum)) continue;
          const ri = total * weights[i] % sum;
          const rj = total * weights[j] % sum;
          assert.ok(ri > rj || (ri === rj && i < j));
        }
      }
    }
  }
});
