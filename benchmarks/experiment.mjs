import path from "node:path";
import { mkdir } from "node:fs/promises";
import { tasks } from "./tasks.mjs";
import { budget, groups, hash, runCase, saveJson, summarize } from "./runner.mjs";
import { sourceSnapshot } from "../.ai-harness/src/snapshot.mjs";
import { redact } from "../.ai-harness/src/evidence.mjs";

export function experimentPlan({ weak, strong, client = "codex", comparison = "reference", repetitions = 1, timeoutMs = budget.timeoutMs, maxToolCalls = budget.maxToolCalls }) {
  if (!["codex", "claude", "gemini"].includes(client) || !["paired", "reference"].includes(comparison)) throw new Error("Invalid client or comparison");
  if (typeof weak !== "string" || !weak.trim() || (comparison === "reference" && (typeof strong !== "string" || !strong.trim()))) throw new Error("Models must be explicit");
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 100) throw new Error("repetitions must be 1..100");
  if (![timeoutMs, maxToolCalls].every(value => Number.isSafeInteger(value) && value > 0) || timeoutMs > 2147483647) throw new Error("Budgets must be positive integers within the timer range");
  const matrix = groups(weak, strong).filter(group => comparison === "reference" || group.id !== "strong-reference");
  const schedule = [];
  for (let trial = 1; trial <= repetitions; trial++) for (let index = 0; index < tasks.length; index++) for (let offset = 0; offset < matrix.length; offset++) {
    const group = matrix[(index + trial - 1 + offset) % matrix.length];
    schedule.push({ taskId: tasks[index].id, group: group.id, trial, directory: `${tasks[index].id}-${group.id}${repetitions > 1 ? `-trial-${trial}` : ""}` });
  }
  return { schemaVersion: 2, client, comparison, repetitions, groups: matrix, budget: { timeoutMs, maxToolCalls, reasoning: client === "gemini" ? null : budget.reasoning }, schedule };
}

export async function runExperiment({ plan, sourceRoot, outputDirectory, driver, mode = "real", onProgress = () => {} }) {
  if (!["real", "simulated"].includes(mode)) throw new Error("Invalid experiment mode");
  await mkdir(outputDirectory); // 已有实验不可覆盖。
  const source = (await sourceSnapshot(sourceRoot)).digest;
  await saveJson(path.join(outputDirectory, "protocol.json"), { ...plan, mode, source, createdAt: new Date().toISOString(),
    tasks: tasks.map(task => ({ id: task.id, split: task.split, taskDigest: hash(JSON.stringify(task.files)), judgeDigest: hash(JSON.stringify(task.cases)) })) });
  const results = [];
  async function summary(complete, error = null) {
    const sourceAfter = (await sourceSnapshot(sourceRoot)).digest;
    const value = { mode, complete: complete && sourceAfter === source, sourceBefore: source, sourceAfter, error,
      results: results.map(row => ({ taskId: row.taskId, group: row.group, trial: row.trial, success: row.success, functionalPassed: row.grade.ok })),
      notRun: plan.schedule.slice(results.length), groups: results.length ? summarize(results, { extended: true }) : [] };
    await saveJson(path.join(outputDirectory, "summary.json"), value);
    return value;
  }
  try {
    for (const entry of plan.schedule) {
      const task = tasks.find(task => task.id === entry.taskId), group = plan.groups.find(group => group.id === entry.group);
      onProgress({ event: "started", ...entry, model: group.model });
      const result = await runCase({ task, group, trial: entry.trial, sourceRoot, outputDirectory: path.join(outputDirectory, entry.directory), driver, runBudget: plan.budget });
      if (result.mode !== mode) throw new Error("Driver mode differs from the experiment protocol");
      results.push(result);
      onProgress({ event: "finished", ...entry, functional: result.grade.ok, success: result.success, timeout: result.run.timedOut, durationMs: result.run.durationMs });
      await summary(false);
    }
    const result = await summary(true);
    if (!result.complete) throw new Error("Harness source changed during the experiment");
    return result;
  } catch (error) { await summary(false, redact(error.message)); throw error; }
}
