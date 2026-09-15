function rate(passed, samples) {
  const p = passed / samples, z = 1.959963984540054;
  const denominator = 1 + z * z / samples;
  const center = (p + z * z / (2 * samples)) / denominator;
  const margin = z * Math.sqrt(p * (1 - p) / samples + z * z / (4 * samples * samples)) / denominator;
  return { passed, samples, rate: p, interval95: [Math.max(0, center - margin), Math.min(1, center + margin)] };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * fraction;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}

export function trialStatistics(rows) {
  const durations = rows.map(row => row.run.durationMs).filter(value => Number.isFinite(value) && value >= 0);
  const invalidFinal = row => row.run.protocolSuccess === true && !row.run.timedOut && !row.run.toolLimit && !row.run.error && parseFinal(row.run.final) === null;
  return {
    functional: rate(rows.filter(row => row.grade.ok).length, rows.length),
    sharedDelivery: rate(rows.filter(row => row.run.completed && row.scope.ok && row.grade.ok).length, rows.length),
    fullDelivery: rate(rows.filter(row => row.success).length, rows.length),
    protocolFailures: rows.filter(row => row.run.unparsedLines > 0 || row.run.errors?.length ||
      (row.run.protocolSuccess === false && !row.run.timedOut && !row.run.toolLimit && !row.run.error) || invalidFinal(row)).length,
    invalidFinals: rows.filter(invalidFinal).length,
    latency: { observed: durations.length, unknown: rows.length - durations.length, medianMs: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95) },
    usageSamples: rows.filter(row => row.run.usage).length,
    toolCategories: rows.reduce((categories, row) => {
      for (const [name, entry] of Object.entries(row.run.timing?.categories || {})) {
        categories[name] ||= { calls: 0, activeMs: 0 };
        categories[name].calls += entry.calls; categories[name].activeMs += entry.activeMs;
      }
      return categories;
    }, {}),
    limitation: "Wilson 区间仅描述这些试次；同题重复并非独立任务。耗时包含被预算截断的样本，p95不是未截断完成时间；工具类别可重叠，缺失用量不计为零。",
  };
}
import { parseFinal } from "./protocol.mjs";
