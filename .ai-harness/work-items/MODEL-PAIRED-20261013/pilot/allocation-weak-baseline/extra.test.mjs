import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.mjs";
import { invoice } from "../src/caller.mjs";

const max = Number.MAX_SAFE_INTEGER;

test("reject invalid totals rather than silently coerce or lose money", () => {
  for (const total of [-1, 0.5, max + 1, NaN, Infinity, -Infinity, "1", null, undefined, true, 1n, Symbol()]) {
    assert.throws(() => allocate(total, [1]), RangeError);
  }
});

test("reject invalid weights, empty arrays and holes even when no money is allocated", () => {
  for (const weights of [undefined, null, {}, "1", new Uint8Array([1]), [], Array(2), [1, , 2]]) {
    assert.throws(() => allocate(0, weights), RangeError);
  }
  for (const weight of [-1, 0.5, max + 1, NaN, Infinity, -Infinity, "1", null, undefined, true, 1n, Symbol()]) {
    assert.throws(() => allocate(0, [1, weight]), RangeError);
  }
  const inherited = Array(1);
  Object.setPrototypeOf(inherited, { 0: 1 });
  assert.throws(() => allocate(1, inherited), RangeError);
});

test("zero weights cannot receive money and all-zero weights cannot fund a positive total", () => {
  assert.deepEqual(allocate(0, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(0, [1, max]), [0, 0]);
  assert.throws(() => allocate(1, [0, 0]), RangeError);
  assert.deepEqual(allocate(2, [0, 1, 0, 1, 1]), [0, 1, 0, 1, 0]);
  assert.deepEqual(allocate(-0, [-0]), [0]);
});

test("largest remainders conserve the total and ties favor original indices", () => {
  assert.deepEqual(allocate(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocate(10, [1, 2, 3]), [2, 3, 5]);
  assert.deepEqual(allocate(7, [1, 3, 2]), [1, 4, 2]);
});

test("full safe-integer inputs retain precision beyond safe sums and products", () => {
  assert.deepEqual(allocate(max, [1]), [max]);
  assert.deepEqual(allocate(max, [max]), [max]);
  assert.deepEqual(allocate(max, [max, max]), [4503599627370496, 4503599627370495]);
  assert.deepEqual(allocate(max, [max, 1]), [max - 1, 1]);
  assert.deepEqual(allocate(1, [max - 1, max]), [0, 1]);
  assert.deepEqual(allocate(1, [max, max - 1]), [1, 0]);
});

test("allocation does not reorder or mutate a frozen caller-owned input", () => {
  const weights = Object.freeze([3, 1, 2]);
  assert.deepEqual(allocate(7, weights), [4, 1, 2]);
  assert.deepEqual(weights, [3, 1, 2]);
});

test("invoice preserves line metadata and order while assigning conserved amounts", () => {
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

test("exhaustive small cases satisfy quotas, conservation and exact priority", () => {
  for (let a = 0; a <= 4; a++) {
    for (let b = 0; b <= 4; b++) {
      for (let c = 0; c <= 4; c++) {
        const weights = [a, b, c];
        const sum = a + b + c;
        if (sum === 0) continue;
        for (let total = 0; total <= 16; total++) {
          const amounts = allocate(total, weights);
          assert.equal(amounts.reduce((x, y) => x + y, 0), total);
          const floors = weights.map(w => Math.floor(total * w / sum));
          const remainders = weights.map(w => total * w % sum);
          for (let i = 0; i < weights.length; i++) {
            assert.ok(Number.isSafeInteger(amounts[i]));
            assert.ok(amounts[i] === floors[i] || amounts[i] === floors[i] + 1);
            if (weights[i] === 0) assert.equal(amounts[i], 0);
            if (amounts[i] === floors[i] + 1) {
              for (let j = 0; j < weights.length; j++) {
                if (amounts[j] === floors[j]) {
                  assert.ok(remainders[i] > remainders[j] || (remainders[i] === remainders[j] && i < j));
                }
              }
            }
          }
        }
      }
    }
  }
});
