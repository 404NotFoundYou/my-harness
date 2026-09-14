export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("total must be a non-negative safe integer");
  }
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new RangeError("weights must be a non-empty dense array");
  }

  const exactWeights = new Array(weights.length);
  let weightSum = 0n;
  for (let index = 0; index < weights.length; index += 1) {
    if (!Object.hasOwn(weights, index)) {
      throw new RangeError("weights must be a non-empty dense array");
    }
    const weight = weights[index];
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new RangeError("weights must contain non-negative safe integers");
    }
    exactWeights[index] = BigInt(weight);
    weightSum += exactWeights[index];
  }

  if (weightSum === 0n) {
    if (total !== 0) {
      throw new RangeError("positive total requires a positive weight sum");
    }
    return weights.map(() => 0);
  }

  const exactTotal = BigInt(total);
  const allocations = new Array(weights.length);
  const remainders = new Array(weights.length);
  let allocated = 0n;

  for (let index = 0; index < exactWeights.length; index += 1) {
    const product = exactTotal * exactWeights[index];
    const quotient = product / weightSum;
    allocations[index] = Number(quotient);
    remainders[index] = { index, remainder: product % weightSum };
    allocated += quotient;
  }

  remainders.sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  });

  const unitsToDistribute = Number(exactTotal - allocated);
  for (let index = 0; index < unitsToDistribute; index += 1) {
    allocations[remainders[index].index] += 1;
  }

  return allocations;
}
