export function toolCategory(name, command = "") {
  const operation = typeof command === "string" ? /harness\.mjs["']?\s+([a-z-]+)\b/.exec(command)?.[1] : null;
  if (operation) return ["begin", "start", "baseline", "solution", "database", "plan-init", "task-add", "plan-approve"].includes(operation) ? "planning"
    : operation === "guide" ? "guidance" : ["run", "check"].includes(operation) ? "verification" : ["finish", "record", "task-update"].includes(operation) ? "completion" : "runtime-other";
  if (/^(Read|Glob|Grep|read_file|file_read)$/i.test(name || "")) return "reading";
  if (/^(Edit|Write|file_change|apply_patch)$/i.test(name || "")) return "editing";
  if (typeof command === "string" && /^(?:node\s+--(?:test|check)|npm\s+test)\b/.test(command)) return "verification";
  return "unknown";
}

function activeTime(spans, durationMs) {
  let total = 0, end = 0;
  for (const span of spans.toSorted((a, b) => a.startMs - b.startMs)) {
    const right = Math.min(durationMs, span.endMs);
    total += Math.max(0, right - Math.max(end, span.startMs));
    end = Math.max(end, right);
  }
  return total;
}

export function createToolTiming() {
  const tools = new Map();
  const unmatchedEnds = new Set();
  return {
    start(id, at, category = "unknown") {
      if (typeof id === "string" && !tools.has(id)) tools.set(id, { id, startMs: at, endMs: null, category });
    },
    end(id, at) {
      if (typeof id !== "string") return;
      const entry = tools.get(id);
      if (entry && entry.endMs === null) entry.endMs = Math.max(entry.startMs, at);
      else if (!entry) unmatchedEnds.add(id);
    },
    summarize(durationMs) {
      const spans = [...tools.values()].map(entry => ({ ...entry, endMs: entry.endMs ?? durationMs, complete: entry.endMs !== null }));
      const toolActiveMs = activeTime(spans, durationMs);
      const categories = Object.fromEntries([...new Set(spans.map(span => span.category))].map(category => {
        const entries = spans.filter(span => span.category === category);
        return [category, { calls: entries.length, activeMs: activeTime(entries, durationMs) }];
      }));
      return { basis: "local-event-receive-time", toolActiveMs, otherElapsedMs: Math.max(0, durationMs-toolActiveMs), spans, categories, unmatchedCompletions: [...unmatchedEnds],
        limitation: "工具区间按接收事件估计并合并重叠；其余耗时包含模型、网络、客户端启动和收尾，不等于纯推理耗时。" };
    },
  };
}
