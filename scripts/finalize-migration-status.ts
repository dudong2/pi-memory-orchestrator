import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { parseJson } from "../src/json.js";

const backup = process.argv[2];
const consolidationOperationId = process.argv[3];
if (!backup || !consolidationOperationId)
  throw new Error(
    "usage: finalize-migration-status <backup-dir> <consolidation-operation-id>",
  );
const config = loadConfig();
const connection = resolveHindsightConnection(config);
const bankId = "coding-agent::dudong2";
const bank = encodeURIComponent(bankId);
const headers = { Authorization: `Bearer ${connection.apiToken}` };
const inventory = parseJson<{
  summary: Record<string, unknown>;
  documents: Array<{
    bankId: string;
    documentId: string;
    action: string;
    scopeTag?: string;
    factCount: number;
  }>;
}>(
  await readFile(join(backup, "migrations", "inventory.json"), "utf8"),
  "migration inventory",
);
const expected = inventory.documents.filter((item) => item.action === "import");
const documents = (await get(
  `/v1/default/banks/${bank}/documents?limit=1000`,
)) as {
  items: Array<{ id: string; memory_unit_count?: number }>;
  total: number;
};
const documentIds = new Set(documents.items.map((item) => item.id));
const documentMap = new Map(documents.items.map((item) => [item.id, item]));
const missingDocuments = expected.flatMap((item) =>
  documentIds.has(item.documentId)
    ? []
    : [`${item.bankId}/${item.documentId}`],
);
const scopeTags = [
  ...new Set(
    expected.flatMap((item) => (item.scopeTag ? [item.scopeTag] : [])),
  ),
];
const scopeCounts = [];
for (const tag of scopeTags) {
  const counts: Record<string, number> = {};
  for (const type of ["world", "experience", "observation"]) {
    const page = (await get(
      `/v1/default/banks/${bank}/memories/list?type=${type}&tags=${encodeURIComponent(tag)}&tags_match=all_strict&limit=1000`,
    )) as { total: number };
    counts[type] = page.total;
  }
  scopeCounts.push({ tag, counts });
}
const tree = (await get(`/v1/default/banks/${bank}/knowledge-base/tree`)) as {
  roots?: Array<{ children?: unknown[] }>;
};
const operation = (await get(
  `/v1/default/banks/${bank}/operations/${consolidationOperationId}`,
)) as { status?: string };
const scopeRawFactCount = scopeCounts.reduce(
  (sum, item) => sum + item.counts.world + item.counts.experience,
  0,
);
const expectedFactCount = expected.reduce(
  (sum, item) => sum + item.factCount,
  0,
);
const migratedRawFactCount = expected.reduce(
  (sum, item) =>
    sum + Number(documentMap.get(item.documentId)?.memory_unit_count ?? 0),
  0,
);
const result = {
  version: 1,
  createdAt: new Date().toISOString(),
  targetBank: bankId,
  sourceSnapshot: "pi-memory-orchestrator-20260914T045259Z",
  classificationSummary: inventory.summary,
  expectedImportedDocuments: expected.length,
  targetDocuments: documents.total,
  missingDocuments,
  expectedRawFacts: expectedFactCount,
  importedRawFacts: migratedRawFactCount,
  scopeRawFactsIncludingLiveWrites: scopeRawFactCount,
  scopeCounts,
  knowledgeNodes: countNodes(tree.roots ?? []),
  consolidationOperationId,
  consolidationStatus: operation.status ?? "unknown",
  migrationComplete:
    missingDocuments.length === 0 &&
    expected.length === 30 &&
    migratedRawFactCount === expectedFactCount,
};
if (!result.migrationComplete)
  throw new Error(`migration verification failed: ${JSON.stringify(result)}`);
await writeFile(
  join(backup, "migrations", "final-import-result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify({
    documents: expected.length,
    migratedRawFacts: migratedRawFactCount,
    liveScopeRawFacts: scopeRawFactCount,
    knowledgeNodes: result.knowledgeNodes,
    consolidation: result.consolidationStatus,
  })}\n`,
);

async function get(path: string): Promise<unknown> {
  const response = await fetch(`${connection.apiUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
}

function countNodes(nodes: Array<{ children?: unknown[] }>): number {
  return nodes.reduce(
    (sum, node) =>
      sum +
      1 +
      countNodes((node.children ?? []) as Array<{ children?: unknown[] }>),
    0,
  );
}
