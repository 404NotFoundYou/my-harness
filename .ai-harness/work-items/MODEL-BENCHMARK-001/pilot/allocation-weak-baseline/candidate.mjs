export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights) || weights.length === 0) {
    throw new RangeError("total and weights must be non-negative safe integers in a non-empty array");
  }

  const values = [];
  let weightSum = 0n;
  for (let i = 0; i < weights.length; i++) {
    if (!Object.hasOwn(weights, i)) {
      throw new RangeError("weights must be a dense array");
    }
    const weight = weights[i];
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError("weights must be non-negative safe integers");
    }
    values.push(BigInt(weight));
    weightSum += BigInt(weight);
  }

  if (weightSum === 0n) {
    if (total === 0) return values.map(() => 0);
    throw new RangeError("positive total cannot be allocated across zero weights");
  }

  const totalBig = BigInt(total);
  const allocations = [];
  const remainders = [];
  let allocated = 0n;
  for (let i = 0; i < values.length; i++) {
    const numerator = totalBig * values[i];
    const base = numerator / weightSum;
    allocations.push(Number(base));
    remainders.push(numerator % weightSum);
    allocated += base;
  }

  const remaining = Number(totalBig - allocated);
  const order = values.map((_, i) => i);
  order.sort((a, b) => {
    if (remainders[a] > remainders[b]) return -1;
    if (remainders[a] < remainders[b]) return 1;
    return a - b;
  });
  for (let i = 0; i < remaining; i++) allocations[order[i]]++;

  return allocations;
}
