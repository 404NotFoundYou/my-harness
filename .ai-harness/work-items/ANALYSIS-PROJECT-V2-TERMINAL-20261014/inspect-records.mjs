import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sourceSnapshot } from "../../src/snapshot.mjs";
import { codexProtocol } from "../../../benchmarks/codex-driver.mjs";
import { parseFinal } from "../../../benchmarks/protocol.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../..");
const read = async file => JSON.parse(await readFile(file, "utf8"));
const baseline = await read(path.join(directory, "investigation-baseline.json"));
const experiment = path.join(root, baseline.experiment);
const histories = await read(path.join(directory, "historical-hashes.json"));
let protectedFiles = 0;
for (const history of histories) for (const [file, digest] of Object.entries(history.files)) {
  assert.equal(createHash("sha256").update(await readFile(path.join(root, history.directory, file))).digest("hex"), digest, history.directory + "/" + file);
  protectedFiles++;
}
assert.equal(protectedFiles, 474, "the diagnosis must preserve all original failed/successful evidence");
assert.equal((await sourceSnapshot(root)).digest, baseline.source);
const protocol = await read(path.join(experiment, "protocol.json"));
const execution = await read(path.join(experiment, "execution.json"));
assert.equal(protocol.mode, "real");
assert.equal(protocol.schedule.length, 6);
assert.ok(execution.trials.every(entry => entry.status === "completed"));
const rows = [];
for (const entry of protocol.schedule) {
  const folder = path.join(experiment, entry.directory);
  const result = await read(path.join(folder, "result.json"));
  const events = (await readFile(path.join(folder, "events.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const recordedFinal = await read(path.join(folder, "final.json"));
  const reparsed = codexProtocol(events);
  assert.equal(reparsed.turnCompleted, result.run.turnCompleted);
  assert.equal(reparsed.protocolSuccess, result.run.protocolSuccess);
  assert.deepEqual(recordedFinal, result.run.final);
  const calls = events.filter(event => event.type === "item.completed" && event.item?.type === "command_execution");
  const startedCalls = events.filter(event => event.type === "item.started" && event.item?.type === "command_execution");
  const lastSpan = result.run.timing.spans.filter(span => span.complete).sort((a, b) => b.endMs - a.endMs)[0];
  assert.ok(lastSpan);
  const lastEventIndex = events.findLastIndex(event => event.type === "item.completed" && event.item?.id === lastSpan.id);
  assert.ok(lastEventIndex >= 0);
  const lastCommand = calls.find(event => event.item.id === lastSpan.id);
  const afterLastCommand = events.slice(lastEventIndex + 1).map(event => ({ type: event.type, itemType: event.item?.type ?? null,
    itemId: event.item?.id ?? null, textBytes: Buffer.byteLength(event.item?.text || ""), validStructuredFinal: Boolean(parseFinal(event.item?.text)) }));
  const itemWarnings = events.filter(event => event.item?.type === "error").map(event => ({ id: event.item.id,
    ignoredConfigSettings: /unrecognized configuration settings/.test(event.item.message || event.item.text || "") }));
  const sharedMemoryReads = calls.filter(event => /\.codex[\\/]+memories(?:[\\/]|$)/i.test(event.item.command || "")).map(event => ({ eventId: event.item.id,
    outputBytes: Buffer.byteLength(event.item.aggregated_output || ""), combinedWithPublicTest: /node\s+--test\s+test\/public\.test\.mjs/.test(event.item.command) }));
  const stderr = (await readFile(path.join(folder, "stderr.txt"), "utf8")).split(/\r?\n/).filter(Boolean);
  const stderrTimes = stderr.map(line => /^(\d{4}-\d\d-\d\dT[^ ]+)\s/.exec(line)?.[1]).filter(Boolean).map(value => Date.parse(value) - Date.parse(result.run.startedAt));
  const workItems = [];
  for (const id of result.workflow?.workItems || []) {
    const state = await read(path.join(folder, "work-items", id, "state.json"));
    workItems.push({ id, type: state.type, status: state.status, stages: (state.verification?.stages || []).map(stage => ({ stage: stage.stage, status: stage.status, commandId: stage.command ?? null })) });
  }
  rows.push({ taskId: entry.taskId, group: entry.group, fullDelivery: result.success, workflow: result.workflow?.ok ?? null,
    timedOut: result.run.timedOut, toolLimit: result.run.toolLimit, toolCalls: result.run.toolCalls, lastCommandId: lastSpan.id,
    lastCommandExitCode: lastCommand?.item.exit_code ?? null, lastToolEndMs: lastSpan.endMs,
    afterLastToolMs: result.run.durationMs - lastSpan.endMs, observedExitCloseGapMs: result.run.timing.lifecycle.processCloseMs - result.run.timing.lifecycle.processExitMs,
    finalFileIsNull: recordedFinal === null, validFinalMessages: events.filter(event => event.item?.type === "agent_message" && parseFinal(event.item.text)).length,
    afterLastCommand, unclosedCommandIds: startedCalls.filter(event => !calls.some(value => value.item.id === event.item.id)).map(event => event.item.id),
    lifecycle: result.run.timing.lifecycle, topLevelProtocolErrors: reparsed.errors.length, jsonUnparsedLines: result.run.unparsedLines,
    itemWarningCount: itemWarnings.length, ignoredConfigWarningCount: itemWarnings.filter(value => value.ignoredConfigSettings).length,
    sharedMemoryReads, workItems, stderr: { lines: stderr.length, lastTimestampOffsetMs: stderrTimes.at(-1) ?? null,
      timestampedLinesAfterLastTool: stderrTimes.filter(value => value > lastSpan.endMs).length,
      mcpStartupTimeoutLines: stderr.filter(line => /MCP server startup failed.*timed out handshaking/.test(line)).length,
      mcpShutdownWarnings: stderr.filter(line => /initialize MCP client during shutdown/.test(line)).length,
      modelTransportRetryClues: stderr.filter(line => /codex_api|codex_client|stream disconnected|retrying.*responses|responses.*retry/i.test(line)).length } });
}
const evidence = { recordedAt: new Date().toISOString(), source: baseline.source, experiment: baseline.experiment,
  inspectedSamples: rows.length, protectedHistoricalFiles: protectedFiles, actualNewModelSessions: 0, rows,
  observations: { harnessWithoutTerminalEvents: rows.filter(row => row.group === "weak-harness" && row.lifecycle.terminalEventMs === null).length,
    completedBugfixItemsBeforeTimeout: rows.filter(row => row.group === "weak-harness" && row.workItems.some(item => item.status === "DONE") && row.timedOut).length,
    sharedMemoryReadSessions: rows.filter(row => row.sharedMemoryReads.length).map(row => ({ taskId: row.taskId, group: row.group })),
    noOpenCommandSessions: rows.filter(row => row.unclosedCommandIds.length === 0).length },
  boundaries: ["event stream records order, not timestamps for every assistant message", "archived final null is canonicalized by the driver; missing and invalid original final output are not distinguished",
    "last tool to timeout is an observed censored interval and cannot identify model, network, schema handling or client delay", "shared memory shell reads do not prove how memory instructions entered the original prompt",
    "common configuration and MCP warnings cannot alone explain the between-group delivery difference"] };
await writeFile(path.join(directory, "terminal-analysis.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ inspectedSamples: rows.length, protectedHistoricalFiles: protectedFiles, actualNewModelSessions: 0, observations: evidence.observations,
  intervals: rows.map(row => ({ taskId: row.taskId, group: row.group, lastToolEndMs: row.lastToolEndMs, afterLastToolMs: row.afterLastToolMs, terminalEventMs: row.lifecycle.terminalEventMs,
    observedExitCloseGapMs: row.observedExitCloseGapMs, lastStderrOffsetMs: row.stderr.lastTimestampOffsetMs, sharedMemoryReadEvents: row.sharedMemoryReads.length })) }, null, 2));
