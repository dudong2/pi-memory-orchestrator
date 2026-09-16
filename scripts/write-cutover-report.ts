import { existsSync, readFileSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseJson } from "../src/json.js";

const backup = process.argv[2];
if (!backup) throw new Error("usage: write-cutover-report <backup-dir>");
const acceptance = parseJson<any>(
  readFileSync(join(backup, "acceptance", "shadow-acceptance.json"), "utf8"),
  "shadow acceptance report",
);
const migration = parseJson<any>(
  readFileSync(join(backup, "migrations", "final-import-result.json"), "utf8"),
  "final import result",
);
const config = parseJson<any>(
  readFileSync(
    `${process.env.HOME}/.config/pi-memory-orchestrator/config.json`,
    "utf8",
  ),
  "memory orchestrator config",
);
const piSettings = parseJson<any>(
  readFileSync(`${process.env.HOME}/.pi/agent/settings.json`, "utf8"),
  "Pi settings",
);
const ompConfig = readFileSync(
  `${process.env.HOME}/.omp/agent/config.yml`,
  "utf8",
);
const pluginLock = parseJson<{
  plugins?: Record<string, { enabled?: boolean }>;
}>(
  readFileSync(
    `${process.env.HOME}/.omp/plugins/omp-plugins.lock.json`,
    "utf8",
  ),
  "OMP plugin lock",
);
const plugin = (name: string) => pluginLock.plugins?.[name];
const outboxRoot = join(config.dataDir, "outbox");
const outbox = Object.fromEntries(
  await Promise.all(
    ["pending", "processing", "failed"].map(async (name) => [
      name,
      existsSync(join(outboxRoot, name))
        ? (await readdir(join(outboxRoot, name))).filter((file) =>
            file.endsWith(".json"),
          ).length
        : 0,
    ]),
  ),
);
const connection = parseJson<{ apiUrl: string; apiToken: string }>(
  readFileSync(`${process.env.HOME}/.hindsight/coding-agent.json`, "utf8"),
  "Hindsight connection",
);
const bank = encodeURIComponent(config.bankId);
const headers = { Authorization: `Bearer ${connection.apiToken}` };
const health = await get("/health");
const consolidation = await get(
  `/v1/default/banks/${bank}/operations/${migration.consolidationOperationId}`,
);
const stats = await get(`/v1/default/banks/${bank}/stats`);
const crossHarness = [];
for (const { query, expectedHarness } of [
  { query: "CrossHarnessPiFinal20260914", expectedHarness: "pi" },
  { query: "CrossHarnessOmpFinal20260914", expectedHarness: "omp" },
]) {
  const result = await get(
    `/v1/default/banks/${bank}/memories/list?q=${query}&limit=20`,
  );
  const source = result.items?.find(
    (item: { metadata?: { harness?: string } }) =>
      item.metadata?.harness === expectedHarness,
  );
  crossHarness.push({
    query,
    count: result.total,
    expectedHarness,
    harness: source?.metadata?.harness,
  });
}
const report = {
  version: 1,
  createdAt: new Date().toISOString(),
  status: "active-with-background-consolidation",
  acceptance: {
    capturedTurns: acceptance.capturedTurns,
    correctionChains: acceptance.correctionChains,
    recallQueries: acceptance.recallQueries,
    successfulQueries: acceptance.successfulQueries,
    failedQueries: acceptance.failedQueries,
    p95Ms: acceptance.p95Ms,
    failureIsolation: acceptance.failureIsolation,
  },
  migration: {
    complete: migration.migrationComplete,
    importedDocuments: migration.expectedImportedDocuments,
    importedRawFacts: migration.importedRawFacts,
    scopeRawFactsIncludingLiveWrites:
      migration.scopeRawFactsIncludingLiveWrites,
    classificationSummary: migration.classificationSummary,
    knowledgeNodes: migration.knowledgeNodes,
  },
  wiring: {
    mode: config.mode,
    bankId: config.bankId,
    piHermesPackage:
      piSettings.packages?.includes("npm:pi-hermes-memory") ?? false,
    piOrchestratorPackage:
      piSettings.packages?.some((item: unknown) =>
        String(item).includes("pi-memory-orchestrator"),
      ) ?? false,
    piOfficialHindsightExtension:
      piSettings.extensions?.some((item: unknown) =>
        String(item).includes("hindsight/coding-agents"),
      ) ?? false,
    ompPiHermesEnabled: plugin("pi-hermes-memory")?.enabled === true,
    ompOfficialHindsightEnabled:
      plugin("@vectorize-io/hindsight-coding-agents")?.enabled === true,
    ompOrchestratorPackageEnabled:
      plugin("pi-memory-orchestrator")?.enabled === true,
    ompOrchestratorWrapper: existsSync(
      `${process.env.HOME}/.omp/agent/extensions/pi-memory-orchestrator.ts`,
    ),
    ompOfficialBridge:
      existsSync(
        `${process.env.HOME}/.omp/agent/extensions/hindsight-coding-agents.ts`,
      ) || ompConfig.includes("hindsight-coding-agents.ts"),
  },
  crossHarness,
  outbox,
  hindsight: {
    health,
    consolidationStatus: consolidation.status,
    pendingConsolidation: stats.pending_consolidation,
    observations: stats.total_observations,
    recallTypes: config.recallTypes,
    preferObservations: config.preferObservations,
  },
  residuals: [
    "Final-bank consolidation continues in the Hindsight worker. Active recall includes raw facts with prefer_observations until the backlog reaches zero.",
    "OMP model execution still has the pre-existing 401 invalid API key problem. Extension commands and OMP-authored Hindsight writes were verified independently of the model.",
    "An OMP manual recall command exceeded its 2-second extension-command budget once while consolidation was saturated; automatic provider calls remain bounded by the configured 30-second fail-open path.",
  ],
};
const passed =
  report.acceptance.failedQueries === 0 &&
  report.acceptance.recallQueries >= 100 &&
  report.acceptance.capturedTurns >= 50 &&
  report.acceptance.correctionChains >= 10 &&
  report.acceptance.p95Ms < 5_000 &&
  report.migration.complete &&
  report.wiring.mode === "active" &&
  report.wiring.piHermesPackage &&
  report.wiring.piOrchestratorPackage &&
  !report.wiring.piOfficialHindsightExtension &&
  report.wiring.ompPiHermesEnabled &&
  !report.wiring.ompOfficialHindsightEnabled &&
  !report.wiring.ompOrchestratorPackageEnabled &&
  report.wiring.ompOrchestratorWrapper &&
  !report.wiring.ompOfficialBridge &&
  report.crossHarness.some((item) => item.harness === "pi") &&
  report.crossHarness.some((item) => item.harness === "omp") &&
  Object.values(report.outbox).every((count) => count === 0);
Object.assign(report, { acceptanceGatePassed: passed });
await writeFile(
  join(backup, "cutover-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify({
    passed,
    status: report.status,
    pendingConsolidation: report.hindsight.pendingConsolidation,
    observations: report.hindsight.observations,
  })}\n`,
);
if (!passed) process.exitCode = 1;

async function get(path: string): Promise<any> {
  const response = await fetch(`${connection.apiUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}
