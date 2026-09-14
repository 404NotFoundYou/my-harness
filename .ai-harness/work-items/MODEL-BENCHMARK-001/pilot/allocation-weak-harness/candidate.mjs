export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights) || weights.length === 0) {
    throw new RangeError("invalid allocation input");
  }

  const values = [];
  let sum = 0n;
  for (let i = 0; i < weights.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(weights, i) || !Number.isSafeInteger(weights[i]) || weights[i] < 0) {
      throw new RangeError("invalid allocation input");
    }
    values.push(BigInt(weights[i]));
    sum += values[i];
  }

  if (sum === 0n) {
    if (total !== 0) throw new RangeError("invalid allocation input");
    return weights.map(() => 0);
  }

  const totalValue = BigInt(total);
  const allocations = values.map(weight => totalValue * weight / sum);
  const remainders = values.map((weight, index) => ({
    index,
    remainder: totalValue * weight % sum,
  }));
  let allocated = allocations.reduce((result, value) => result + value, 0n);
  remainders.sort((a, b) => b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index);

  for (let i = 0; i < Number(totalValue - allocated); i++) {
    allocations[remainders[i].index]++;
  }

  return allocations.map(Number);
}
