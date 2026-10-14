import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.mjs";
import { invoice } from "../src/caller.mjs";

const MAX = Number.MAX_SAFE_INTEGER;

test("largest remainders conserve the invoice total and ties favor earlier lines", () => {
  assert.deepEqual(allocate(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocate(7, [1, 2, 3]), [1, 2, 4]);
  assert.deepEqual(allocate(1, [0, 1, 1]), [0, 1, 0]);
  assert.deepEqual(allocate(5, [3, 1, 3]), [2, 1, 2]);
});

test("exact arithmetic preserves allocations across the entire safe integer range", () => {
  assert.deepEqual(allocate(MAX, [MAX, MAX - 1]), [4503599627370496, 4503599627370495]);
  assert.deepEqual(allocate(MAX, [1, 1, 1]), [3002399751580331, 3002399751580330, 3002399751580330]);
  assert.deepEqual(allocate(1, [MAX - 1, MAX]), [0, 1]);
  assert.deepEqual(allocate(MAX, [0, MAX, 0]), [0, MAX, 0]);
  assert.deepEqual(allocate(MAX, [MAX]), [MAX]);
});

test("zero totals are valid but zero weights cannot fund a positive total", () => {
  assert.deepEqual(allocate(0, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(0, [MAX, 1, 0]), [0, 0, 0]);
  assert.throws(() => allocate(1, [0, 0]), RangeError);
});

test("invalid totals and weights fail explicitly instead of coercing invoice data", () => {
  const invalid = [-1, 0.5, NaN, Infinity, -Infinity, MAX + 1, "1", null, undefined, true, 1n, {}, Symbol("weight")];
  for (const value of invalid) {
    assert.throws(() => allocate(value, [1]), RangeError);
    assert.throws(() => allocate(1, [1, value]), RangeError);
    assert.throws(() => allocate(0, [value]), RangeError);
  }
  for (const weights of [null, undefined, {}, "12", new Uint8Array([1]), [], new Array(2), [1, , 2]]) {
    assert.throws(() => allocate(1, weights), RangeError);
  }
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, { 0: 1 });
  assert.throws(() => allocate(1, inherited), RangeError);
});

test("allocation leaves frozen caller inputs untouched and invoice retains line metadata", () => {
  const weights = Object.freeze([3, 1, 3]);
  assert.deepEqual(allocate(5, weights), [2, 1, 2]);
  assert.deepEqual(weights, [3, 1, 3]);
  const lines = Object.freeze([
    Object.freeze({ id: "a", weight: 1 }),
    Object.freeze({ id: "b", weight: 1 }),
    Object.freeze({ id: "c", weight: 1 }),
  ]);
  assert.deepEqual(invoice(2, lines), [
    { id: "a", weight: 1, amount: 1 },
    { id: "b", weight: 1, amount: 1 },
    { id: "c", weight: 1, amount: 0 },
  ]);
  assert.equal(Object.hasOwn(lines[0], "amount"), false);
});

test("small exhaustive cases preserve total, zero lines, and exact remainder priority", () => {
  for (let a = 0; a <= 4; a++) {
    for (let b = 0; b <= 4; b++) {
      for (let c = 0; c <= 4; c++) {
        const weights = [a, b, c];
        const sum = a + b + c;
        if (sum === 0) continue;
        for (let total = 0; total <= 20; total++) {
          const floors = weights.map(w => Math.floor(total * w / sum));
          const priority = [0, 1, 2].sort((i, j) => (total * weights[j] % sum) - (total * weights[i] % sum) || i - j);
          const expected = floors.slice();
          const remaining = total - floors.reduce((x, y) => x + y, 0);
          for (const index of priority.slice(0, remaining)) expected[index]++;
          const result = allocate(total, weights);
          assert.deepEqual(result, expected);
          assert.equal(result.reduce((x, y) => x + y, 0), total);
          result.forEach((value, index) => {
            assert.ok(Number.isSafeInteger(value) && value >= 0);
            if (weights[index] === 0) assert.equal(value, 0);
          });
        }
      }
    }
  }
});
