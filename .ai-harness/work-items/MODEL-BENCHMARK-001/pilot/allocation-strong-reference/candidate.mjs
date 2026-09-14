export function allocate(total, weights) { const sum = weights.reduce((a,b) => a+b,0); return weights.map(w => Math.round(total*w/sum)); }
