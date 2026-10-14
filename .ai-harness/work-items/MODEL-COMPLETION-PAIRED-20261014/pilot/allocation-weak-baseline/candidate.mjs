export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights) || weights.length === 0) {
    throw new RangeError("Expected a non-negative safe total and a non-empty dense weights array");
  }

  const exactWeights = [];
  let sum = 0n;
  for (let i = 0; i < weights.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(weights, i)) {
      throw new RangeError("Weights must be dense");
    }
    const weight = weights[i];
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError("Weights must be non-negative safe integers");
    }
    const exactWeight = BigInt(weight);
    exactWeights.push(exactWeight);
    sum += exactWeight;
  }

  if (sum === 0n) {
    if (total !== 0) throw new RangeError("A positive total requires a positive weight");
    return exactWeights.map(() => 0);
  }

  const exactTotal = BigInt(total);
  let allocated = 0n;
  const remainders = [];
  const amounts = exactWeights.map((weight, index) => {
    const product = exactTotal * weight;
    const amount = product / sum;
    allocated += amount;
    remainders.push({ index, remainder: product % sum });
    return Number(amount);
  });
  remainders.sort((a, b) => {
    if (a.remainder === b.remainder) return a.index - b.index;
    return a.remainder > b.remainder ? -1 : 1;
  });
  const remaining = Number(exactTotal - allocated);
  for (let i = 0; i < remaining; i++) {
    amounts[remainders[i].index] += 1;
  }
  return amounts;
}
