export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights) || weights.length === 0) {
    throw new RangeError("Expected a non-negative safe total and a non-empty dense weights array");
  }
  const exactWeights = [];
  let sum = 0n;
  for (let i = 0; i < weights.length; i++) {
    if (!Object.hasOwn(weights, i)) throw new RangeError("Weights must be dense");
    const weight = weights[i];
    if (!Number.isSafeInteger(weight) || weight < 0) throw new RangeError("Invalid weight");
    const exact = BigInt(weight);
    exactWeights.push(exact);
    sum += exact;
  }
  if (sum === 0n) {
    if (total !== 0) throw new RangeError("Cannot allocate a positive total to zero weights");
    return weights.map(() => 0);
  }
  const exactTotal = BigInt(total);
  let remaining = exactTotal;
  const remainders = [];
  const result = exactWeights.map((weight, index) => {
    const numerator = exactTotal * weight;
    const whole = numerator / sum;
    remaining -= whole;
    remainders.push({ index, remainder: numerator % sum });
    return Number(whole);
  });
  remainders.sort((a, b) => a.remainder === b.remainder
    ? a.index - b.index
    : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; i < Number(remaining); i++) result[remainders[i].index]++;
  return result;
}
