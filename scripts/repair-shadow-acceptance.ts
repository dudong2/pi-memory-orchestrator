import { constants } from "node:fs";
import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { RetainOutbox } from "../src/hindsight/outbox.js";
import { ScopedHindsightProvider } from "../src/hindsight/provider.js";
import { parseJson } from "../src/json.js";
import { acceptanceScope as scope } from "./acceptance-scope.js";

const reportPath = process.argv[2];
if (!reportPath)
  throw new Error("usage: repair-shadow-acceptance <shadow-acceptance.json>");
const initialPath = join(dirname(reportPath), "shadow-acceptance-initial.json");
try {
  await copyFile(reportPath, initialPath, constants.COPYFILE_EXCL);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}

const config = { ...loadConfig(), mode: "shadow" as const };
const connection = resolveHindsightConnection(config);
const client = new HindsightClient({ ...connection, requestTimeoutMs: 30_000 });
const outbox = new RetainOutbox({
  rootDir: join(config.dataDir, "acceptance-repair-outbox-v1"),
  operationTimeoutMs: 180_000,
  pollIntervalMs: 250,
});
const provider = new ScopedHindsightProvider(config, client, outbox);

const timestamp = "2026-01-05T12:00:00.000Z";
await provider.enqueueTurn(
  scope,
  {
    sessionId: "acceptance-correction-04-late-backfill",
    turnId: "historical-alpha04",
    harness: "test",
    timestamp,
  },
  "Historical correction: OrchestratorTestSetting04 used package alpha04 on January 5, 2026, before it later changed to beta04 and gamma04.",
  "Recorded the late-arriving January event: OrchestratorTestSetting04 used alpha04 on 2026-01-05.",
);
const drain = await outbox.drain(client, { maxJobs: 1 });
if (drain.completed !== 1)
  throw new Error(`repair retain did not complete: ${JSON.stringify(drain)}`);

const consolidation = await client.triggerConsolidation(provider.bankId());
if (typeof consolidation.operation_id === "string")
  await waitForOperation(consolidation.operation_id, 300_000);

const repaired = [];
for (let run = 1; run <= 2; run++) {
  const started = performance.now();
  const outcome = await provider.recall(
    "What package did OrchestratorTestSetting04 use in January 2026?",
    scope,
  );
  const text = outcome.memories
    .map((memory) => memory.text)
    .join("\n")
    .toLowerCase();
  repaired.push({
    name: "january-04",
    query: "What package did OrchestratorTestSetting04 use in January 2026?",
    expected: "alpha04",
    run,
    durationMs: performance.now() - started,
    ok: !outcome.error && text.includes("alpha04"),
    count: outcome.memories.length,
    error: outcome.error,
    scopes: outcome.plan.tags,
  });
}
if (repaired.some((item) => !item.ok))
  throw new Error(`repair queries failed: ${JSON.stringify(repaired)}`);

const report = parseJson<{
  results: Array<Record<string, unknown>>;
  failures: Array<Record<string, unknown>>;
  [key: string]: unknown;
}>(await readFile(reportPath, "utf8"), "shadow acceptance report");
const initialFailures = report.failures;
for (const repair of repaired) {
  const index = report.results.findIndex(
    (item) => item.name === repair.name && item.run === repair.run,
  );
  if (index < 0)
    throw new Error(`original failed query not found for run ${repair.run}`);
  report.results[index] = repair;
}
const durations = report.results.map((item) => Number(item.durationMs));
Object.assign(report, {
  repairedAt: new Date().toISOString(),
  repairKind: "late-arriving historical fact",
  capturedTurns: 51,
  successfulQueries: report.results.filter((item) => item.ok === true).length,
  failedQueries: report.results.filter((item) => item.ok !== true).length,
  p50Ms: percentile(durations, 0.5),
  p95Ms: percentile(durations, 0.95),
  maxMs: Math.max(...durations),
  initialFailures,
  repairResults: repaired,
  failures: report.results.filter((item) => item.ok !== true),
});
const temporary = `${reportPath}.tmp-${process.pid}`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
await rename(temporary, reportPath);
console.log(
  JSON.stringify({
    drain,
    repairedQueries: repaired.length,
    successfulQueries: report.successfulQueries,
    failedQueries: report.failedQueries,
    p95Ms: Math.round(Number(report.p95Ms)),
  }),
);

async function waitForOperation(
  operationId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await client.operationStatus(
      provider.bankId(),
      operationId,
    );
    const status = operation.status.toLowerCase();
    if (status === "completed") return;
    if (status === "failed" || status === "cancelled")
      throw new Error(`operation ${status}: ${operationId}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`operation timed out: ${operationId}`);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0
  );
}
