export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights) || weights.length === 0) {
    throw new RangeError("invalid allocation input");
  }

  let sum = 0n;
  for (let i = 0; i < weights.length; i += 1) {
    if (!Object.hasOwn(weights, i) || !Number.isSafeInteger(weights[i]) || weights[i] < 0) {
      throw new RangeError("invalid allocation input");
    }
    sum += BigInt(weights[i]);
  }

  if (sum === 0n) {
    if (total !== 0) throw new RangeError("zero weights require zero total");
    return weights.map(() => 0);
  }

  const totalBigInt = BigInt(total);
  const allocations = [];
  let allocated = 0n;
  for (let i = 0; i < weights.length; i += 1) {
    const numerator = totalBigInt * BigInt(weights[i]);
    const amount = numerator / sum;
    allocations.push({ index: i, amount, remainder: numerator % sum });
    allocated += amount;
  }

  const remaining = Number(totalBigInt - allocated);
  allocations.sort((a, b) => b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index);
  for (let i = 0; i < remaining; i += 1) allocations[i].amount += 1n;

  const result = Array(weights.length).fill(0);
  for (const allocation of allocations) result[allocation.index] = Number(allocation.amount);
  return result;
}
