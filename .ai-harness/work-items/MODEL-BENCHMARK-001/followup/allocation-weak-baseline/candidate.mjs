export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("total must be a non-negative safe integer");
  if (!Array.isArray(weights) || weights.length === 0) throw new RangeError("weights must be a non-empty dense array");

  const exactWeights = Array.from({ length: weights.length }, (_, index) => {
    if (!Object.hasOwn(weights, index)) {
      throw new RangeError("weights must contain non-negative safe integers");
    }
    const weight = weights[index];
    if (!Number.isSafeInteger(weight) || weight < 0) throw new RangeError("weights must contain non-negative safe integers");
    return BigInt(weight);
  });
  const weightSum = exactWeights.reduce((sum, weight) => sum + weight, 0n);

  if (weightSum === 0n) {
    if (total === 0) return exactWeights.map(() => 0);
    throw new RangeError("positive total requires a positive weight sum");
  }

  const exactTotal = BigInt(total);
  const shares = exactWeights.map((weight, index) => {
    const numerator = exactTotal * weight;
    return { amount: numerator / weightSum, remainder: numerator % weightSum, index };
  });
  let remaining = exactTotal - shares.reduce((sum, share) => sum + share.amount, 0n);

  const byRemainder = [...shares].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.index - b.index;
  });
  for (const share of byRemainder) {
    if (remaining === 0n) break;
    shares[share.index].amount += 1n;
    remaining -= 1n;
  }

  return shares.map(({ amount }) => Number(amount));
}
