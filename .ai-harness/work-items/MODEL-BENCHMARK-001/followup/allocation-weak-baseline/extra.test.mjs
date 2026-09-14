import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.mjs";
import { invoice } from "../src/caller.mjs";

test("rejects invalid inputs because allocations must be safe, dense integer shares", () => {
  for (const total of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"]) {
    assert.throws(() => allocate(total, [1]), RangeError);
  }
  for (const weights of [[], null, {}, [1, -1], [1, 0.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    assert.throws(() => allocate(1, weights), RangeError);
  }
  const sparse = [1, , 1];
  assert.throws(() => allocate(1, sparse), RangeError);
});

test("only a zero total can be allocated when every weight is zero", () => {
  assert.deepEqual(allocate(0, [0, 0]), [0, 0]);
  assert.throws(() => allocate(1, [0, 0]), RangeError);
});

test("uses exact remainders and stable input order for ties at safe-integer limits", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(allocate(max, [1, 1]), [4503599627370496, 4503599627370495]);
  assert.deepEqual(allocate(max, [max, max]), [4503599627370496, 4503599627370495]);
  assert.deepEqual(allocate(max, [1, 1, 1]), [3002399751580331, 3002399751580330, 3002399751580330]);
});

test("preserves zero-weight shares, the exact total, and caller-owned input", () => {
  const weights = [0, 2, 1];
  const before = [...weights];
  const result = allocate(5, weights);

  assert.deepEqual(result, [0, 3, 2]);
  assert.equal(result.reduce((sum, amount) => sum + amount, 0), 5);
  assert.deepEqual(weights, before);
});

test("keeps invoice callers receiving ordered line amounts", () => {
  assert.deepEqual(invoice(7, [{ name: "first", weight: 1 }, { name: "second", weight: 2 }]), [
    { name: "first", weight: 1, amount: 2 },
    { name: "second", weight: 2, amount: 5 },
  ]);
});
