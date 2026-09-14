import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.mjs";
import { invoice } from "../src/caller.mjs";

test("largest remainders conserve the total and ties favor earlier inputs", () => {
  assert.deepEqual(allocate(2, [1, 1, 1]), [1, 1, 0]);
  assert.deepEqual(allocate(7, [0, 2, 3]), [0, 3, 4]);
});

test("integer arithmetic remains exact beyond Number intermediate precision", () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const result = allocate(maximum, [maximum, maximum - 1, 1]);
  assert.deepEqual(result, [4503599627370496, 4503599627370495, 0]);
  assert.equal(result.reduce((sum, value) => sum + BigInt(value), 0n), BigInt(maximum));
});

test("zero total and zero-sum weights follow their explicit contract", () => {
  assert.deepEqual(allocate(0, [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  assert.throws(() => allocate(1, [0, 0]), RangeError);
});

test("invalid totals and weights fail loudly with RangeError", () => {
  for (const total of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1"]) {
    assert.throws(() => allocate(total, [1]), RangeError);
  }
  for (const weights of [[], [1, -1], [1, 0.5], [Number.MAX_SAFE_INTEGER + 1], [NaN], "1"]) {
    assert.throws(() => allocate(1, weights), RangeError);
  }
  const sparse = new Array(2);
  sparse[1] = 1;
  assert.throws(() => allocate(1, sparse), RangeError);
});

test("allocation does not mutate weights and remains caller-compatible", () => {
  const weights = [1, 2, 3];
  const snapshot = [...weights];
  assert.deepEqual(allocate(11, weights), [2, 4, 5]);
  assert.deepEqual(weights, snapshot);
  assert.deepEqual(invoice(5, [{ weight: 1, name: "a" }, { weight: 1, name: "b" }]), [
    { weight: 1, name: "a", amount: 3 },
    { weight: 1, name: "b", amount: 2 },
  ]);
});
