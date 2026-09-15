import test from "node:test";
import assert from "node:assert/strict";
import { present } from "../src/caller.mjs";

test("caller preserves its result shape while using the doubled value", () => {
  assert.deepEqual(present(3), { result: 6 });
});
