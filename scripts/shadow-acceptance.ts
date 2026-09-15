import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { RetainOutbox } from "../src/hindsight/outbox.js";
import { ScopedHindsightProvider } from "../src/hindsight/provider.js";
import type { ResolvedScope } from "../src/scope/resolver.js";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("usage: shadow-acceptance <output-dir>");
await mkdir(outputDir, { recursive: true, mode: 0o700 });

const baseConfig = loadConfig();
const config = {
  ...baseConfig,
  mode: "shadow" as const,
  shadowBankId: "coding-agent::dudong2::acceptance-v2",
  requestTimeoutMs: 180_000,
};
const connection = resolveHindsightConnection(config);
const client = new HindsightClient({ ...connection, requestTimeoutMs: 30_000 });
const outbox = new RetainOutbox({
  rootDir: join(config.dataDir, "acceptance-outbox-v2"),
  operationTimeoutMs: 180_000,
  pollIntervalMs: 250,
  maxAttempts: 20,
});
const provider = new ScopedHindsightProvider(config, client, outbox);
const workspaceId = "ws_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const currentRepo = "github.com/dudong2/scope-current";
const siblingRepo = "github.com/dudong2/scope-sibling";
const scope: ResolvedScope = {
  workspaceRoot: "/acceptance/workspace",
  markerPath: "/acceptance/workspace/.pi-memory-scope.json",
  marker: {
    version: 1,
    workspaceId,
    displayName: "acceptance-workspace",
    repositories: [currentRepo, siblingRepo],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  },
  workspaceTag: `scope:workspace:${workspaceId}`,
  repositoryId: currentRepo,
  repositoryTag: `scope:repo:${currentRepo}`,
  git: null,
  scopeTag: `scope:repo:${currentRepo}`,
  kind: "repository",
  ancestors: [{
    root: "/acceptance",
    markerPath: "/acceptance/.pi-memory-scope.json",
    marker: {
      version: 1,
      workspaceId,
      displayName: "acceptance-workspace",
      repositories: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    kind: "workspace",
    tag: `scope:workspace:${workspaceId}`,
  }],
  knownRepositoryIds: [currentRepo, siblingRepo],
  workspaceRepositoryIds: [currentRepo, siblingRepo],
};

const turns: Array<{ sessionId: string; turnId: string; timestamp: string; user: string; assistant: string; scope: ResolvedScope }> = [];
for (let chain = 1; chain <= 10; chain++) {
  const id = String(chain).padStart(2, "0");
  for (const [stage, date, value] of [
    ["a", "2026-01-05T12:00:00.000Z", `alpha${id}`],
    ["b", "2026-02-05T12:00:00.000Z", `beta${id}`],
    ["c", "2026-03-05T12:00:00.000Z", `gamma${id}`],
  ] as const) {
    turns.push({
      sessionId: `acceptance-correction-${id}`,
      turnId: `${stage}-${id}`,
      timestamp: date,
      user: `OrchestratorTestSetting${id} now uses package ${value}. This replaces its previous package value.`,
      assistant: `Recorded: OrchestratorTestSetting${id} uses package ${value} as of ${date.slice(0, 10)}.`,
      scope,
    });
  }
}
for (let index = 1; index <= 10; index++) {
  const id = String(index).padStart(2, "0");
  const workspaceOnly: ResolvedScope = {
    ...scope,
    repositoryId: undefined,
    repositoryTag: undefined,
    scopeTag: scope.workspaceTag,
    kind: "workspace",
    ancestors: [],
  };
  turns.push({
    sessionId: `acceptance-workspace-${id}`,
    turnId: `workspace-${id}`,
    timestamp: `2026-04-${id}T12:00:00.000Z`,
    user: `SharedWorkspaceRule${id} requires protocol workspacevalue${id} in every child repository.`,
    assistant: `Recorded shared workspace protocol workspacevalue${id}.`,
    scope: workspaceOnly,
  });
}
for (let index = 1; index <= 5; index++) {
  const id = String(index).padStart(2, "0");
  turns.push({
    sessionId: `acceptance-current-${id}`,
    turnId: `current-${id}`,
    timestamp: `2026-05-${id}T12:00:00.000Z`,
    user: `CurrentRepoRule${id} uses currentvalue${id} only in scope-current.`,
    assistant: `Recorded current repository value currentvalue${id}.`,
    scope,
  });
}
for (let index = 1; index <= 5; index++) {
  const id = String(index).padStart(2, "0");
  const siblingScope: ResolvedScope = {
    ...scope,
    repositoryId: siblingRepo,
    repositoryTag: `scope:repo:${siblingRepo}`,
    scopeTag: `scope:repo:${siblingRepo}`,
  };
  turns.push({
    sessionId: `acceptance-sibling-${id}`,
    turnId: `sibling-${id}`,
    timestamp: `2026-06-${id}T12:00:00.000Z`,
    user: `SiblingRepoRule${id} uses siblingvalue${id} only in scope-sibling.`,
    assistant: `Recorded sibling repository value siblingvalue${id}.`,
    scope: siblingScope,
  });
}
if (turns.length !== 50) throw new Error(`expected 50 turns, got ${turns.length}`);

for (const turn of turns) {
  await provider.enqueueTurn(turn.scope, {
    sessionId: turn.sessionId,
    turnId: turn.turnId,
    harness: "test",
    timestamp: turn.timestamp,
  }, turn.user, turn.assistant);
}

let completed = 0;
const drainDeadline = Date.now() + 20 * 60_000;
while (Date.now() < drainDeadline) {
  // Production uses a single drain per process. Preserve document append order here;
  // concurrent recall is exercised below, while outbox claim concurrency has its own test.
  const result = await outbox.drain(client, { maxJobs: 5 });
  completed += result.completed;
  const counts = await outbox.counts();
  if (counts.pending === 0 && counts.processing === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
const outboxCounts = await outbox.counts();
if (outboxCounts.pending || outboxCounts.processing || outboxCounts.failed) {
  throw new Error(`outbox did not drain cleanly: ${JSON.stringify(outboxCounts)}`);
}

const consolidation = await client.triggerConsolidation(provider.bankId());
if (typeof consolidation.operation_id === "string") await waitForOperation(consolidation.operation_id, 10 * 60_000);

const baseQueries: Array<{ name: string; query: string; expected?: string; forbidden?: string }> = [];
for (let chain = 1; chain <= 10; chain++) {
  const id = String(chain).padStart(2, "0");
  baseQueries.push({ name: `current-${id}`, query: `What package does OrchestratorTestSetting${id} currently use?`, expected: `gamma${id}` });
  baseQueries.push({ name: `february-${id}`, query: `What package did OrchestratorTestSetting${id} use in February 2026?`, expected: `beta${id}` });
  baseQueries.push({ name: `january-${id}`, query: `What package did OrchestratorTestSetting${id} use in January 2026?`, expected: `alpha${id}` });
}
for (let index = 1; index <= 10; index++) {
  const id = String(index).padStart(2, "0");
  baseQueries.push({ name: `workspace-${id}`, query: `What protocol does SharedWorkspaceRule${id} require?`, expected: `workspacevalue${id}` });
}
for (let index = 1; index <= 5; index++) {
  const id = String(index).padStart(2, "0");
  baseQueries.push({ name: `current-repo-${id}`, query: `What does CurrentRepoRule${id} use?`, expected: `currentvalue${id}`, forbidden: `siblingvalue${id}` });
  baseQueries.push({ name: `sibling-repo-${id}`, query: `In scope-sibling, what does SiblingRepoRule${id} use?`, expected: `siblingvalue${id}` });
}
if (baseQueries.length !== 50) throw new Error(`expected 50 base queries, got ${baseQueries.length}`);
const queries = [...baseQueries, ...baseQueries].map((query, index) => ({ ...query, run: index < 50 ? 1 : 2 }));

const creditsBefore = await readCredits();
const results: Array<Record<string, unknown>> = [];
for (let index = 0; index < queries.length; index += 4) {
  const group = queries.slice(index, index + 4);
  results.push(...await Promise.all(group.map(async (testCase) => {
    const started = performance.now();
    const outcome = await provider.recall(testCase.query, scope);
    const text = outcome.memories.map((memory) => memory.text).join("\n").toLowerCase();
    return {
      ...testCase,
      durationMs: performance.now() - started,
      ok: !outcome.error
        && (!testCase.expected || text.includes(testCase.expected.toLowerCase()))
        && (!testCase.forbidden || !text.includes(testCase.forbidden.toLowerCase())),
      count: outcome.memories.length,
      error: outcome.error,
      scopes: outcome.plan.tags,
    };
  })));
}
await new Promise((resolve) => setTimeout(resolve, 5_000));
const creditsAfter = await readCredits();
const durations = results.map((result) => Number(result.durationMs));
const failures = results.filter((result) => !result.ok);
const report = {
  version: 1,
  createdAt: new Date().toISOString(),
  bankId: provider.bankId(),
  capturedTurns: turns.length,
  completedOutboxJobs: completed,
  correctionChains: 10,
  recallQueries: results.length,
  successfulQueries: results.length - failures.length,
  failedQueries: failures.length,
  p50Ms: percentile(durations, 0.5),
  p95Ms: percentile(durations, 0.95),
  maxMs: Math.max(...durations),
  outboxCounts,
  creditsBefore,
  creditsAfter,
  failures,
  results,
};
await writeFile(join(outputDir, "shadow-acceptance.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  capturedTurns: report.capturedTurns,
  correctionChains: report.correctionChains,
  recallQueries: report.recallQueries,
  successfulQueries: report.successfulQueries,
  failedQueries: report.failedQueries,
  p50Ms: Math.round(report.p50Ms),
  p95Ms: Math.round(report.p95Ms),
  maxMs: Math.round(report.maxMs),
  outboxCounts,
}));
if (failures.length || report.p95Ms > 5_000) process.exitCode = 1;

async function waitForOperation(operationId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await client.operationStatus(provider.bankId(), operationId);
    const status = operation.status.toLowerCase();
    if (status === "completed") return;
    if (status === "failed" || status === "cancelled") throw new Error(`operation ${status}: ${operationId}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`operation timed out: ${operationId}`);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

async function readCredits(): Promise<unknown> {
  const env = readFileSync(`${process.env.HOME}/.hindsight/hindsight-control/server.env`, "utf8");
  const line = env.split(/\r?\n/).find((item) => item.startsWith("HINDSIGHT_API_RERANKER_OPENROUTER_API_KEY="));
  const key = line?.split("=").slice(1).join("=").trim();
  if (!key) return null;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? response.json() : { status: response.status };
  } catch (error) {
    return { error: String(error) };
  }
}
