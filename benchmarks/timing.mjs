export function createToolTiming() {
  const tools = new Map();
  const unmatchedEnds = new Set();
  return {
    start(id, at) {
      if (typeof id === "string" && !tools.has(id)) tools.set(id, { id, startMs: at, endMs: null });
    },
    end(id, at) {
      if (typeof id !== "string") return;
      const entry = tools.get(id);
      if (entry && entry.endMs === null) entry.endMs = Math.max(entry.startMs, at);
      else if (!entry) unmatchedEnds.add(id);
    },
    summarize(durationMs) {
      const spans = [...tools.values()].map(entry => ({ ...entry, endMs: entry.endMs ?? durationMs, complete: entry.endMs !== null }));
      const sorted = spans.toSorted((a,b) => a.startMs-b.startMs);
      let toolActiveMs = 0, end = 0;
      for (const span of sorted) {
        const right = Math.min(durationMs, span.endMs);
        toolActiveMs += Math.max(0, right - Math.max(end, span.startMs));
        end = Math.max(end, right);
      }
      return { basis: "local-event-receive-time", toolActiveMs, otherElapsedMs: Math.max(0, durationMs-toolActiveMs), spans, unmatchedCompletions: [...unmatchedEnds],
        limitation: "工具区间按接收事件估计并合并重叠；其余耗时包含模型、网络、客户端启动和收尾，不等于纯推理耗时。" };
    },
  };
}
