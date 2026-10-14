export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights) || weights.length === 0) {
    throw new RangeError("Expected a non-negative safe integer total and a non-empty dense weights array");
  }
  const values = [];
  let sum = 0n;
  for (let i = 0; i < weights.length; i++) {
    if (!Object.hasOwn(weights, i) || !Number.isSafeInteger(weights[i]) || weights[i] < 0) {
      throw new RangeError("Weights must be non-negative safe integers without holes");
    }
    const value = BigInt(weights[i]);
    values.push(value);
    sum += value;
  }
  if (sum === 0n) {
    if (total !== 0) throw new RangeError("A positive total requires a positive weight");
    return values.map(() => 0);
  }
  let remaining = BigInt(total);
  const remainders = [];
  const amounts = values.map((weight, index) => {
    const product = BigInt(total) * weight;
    const amount = product / sum;
    remaining -= amount;
    remainders.push({ index, remainder: product % sum });
    return Number(amount);
  });
  remainders.sort((a, b) => a.remainder === b.remainder
    ? a.index - b.index
    : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; i < Number(remaining); i++) {
    amounts[remainders[i].index]++;
  }
  return amounts;
}
