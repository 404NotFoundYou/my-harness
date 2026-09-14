import test from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocate.mjs";

test("allocates the largest exact remainders first so the total is preserved", () => {
  assert.deepEqual(allocate(10, [1, 1, 1]), [4, 3, 3]);
  assert.equal(allocate(10, [1, 1, 1]).reduce((sum, amount) => sum + amount, 0), 10);
});

test("breaks equal remainders by original index and keeps zero weights at zero", () => {
  assert.deepEqual(allocate(1, [0, 1, 1]), [0, 1, 0]);
});

test("rejects invalid and sparse inputs, including a nonzero total with zero weights", () => {
  assert.throws(() => allocate(-1, [1]), RangeError);
  assert.throws(() => allocate(1, []), RangeError);
  assert.throws(() => allocate(1, [1.5]), RangeError);
  assert.throws(() => allocate(1, [0, 0]), RangeError);
  assert.throws(() => allocate(1, [, 1]), RangeError);
  assert.deepEqual(allocate(0, [0, 0]), [0, 0]);
});

test("uses exact arithmetic when total times weight exceeds Number safe precision", () => {
  const total = Number.MAX_SAFE_INTEGER;
  const result = allocate(total, [Number.MAX_SAFE_INTEGER, 1]);
  assert.deepEqual(result, [total - 1, 1]);
});
