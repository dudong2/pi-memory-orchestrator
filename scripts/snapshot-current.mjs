import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("usage: node scripts/snapshot-current.mjs <output-dir>");

const clientConfig = JSON.parse(readFileSync(`${process.env.HOME}/.hindsight/coding-agent.json`, "utf8"));
const apiUrl = clientConfig.apiUrl.replace(/\/$/, "");
const headers = {
  Authorization: `Bearer ${clientConfig.apiToken}`,
  "Content-Type": "application/json",
};

await mkdir(outputDir, { recursive: true });

async function request(path, init = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status}`);
  return response.json();
}

const version = await request("/version");
const health = await request("/health");
const banksResponse = await request("/v1/default/banks?limit=200");
const bankSnapshots = [];

for (const bank of banksResponse.banks) {
  const encoded = encodeURIComponent(bank.bank_id);
  const [stats, documents, knowledgeTree] = await Promise.all([
    request(`/v1/default/banks/${encoded}/stats`),
    request(`/v1/default/banks/${encoded}/documents?limit=1`),
    request(`/v1/default/banks/${encoded}/knowledge-base/tree`),
  ]);
  bankSnapshots.push({
    bank,
    stats,
    documentTotal: documents.total,
    knowledgeTree,
  });
}

const queries = [
  { bankId: "coding-agent::LuckyCat", query: "What is the verified rule for no-fill scope?" },
  { bankId: "coding-agent::LuckyCat", query: "What repository architecture and conventions are important in LuckyCat?" },
  { bankId: "user-knowledge", query: "Why must the local MPS reranker concurrency stay at one?" },
  { bankId: "user-knowledge", query: "What was decided about Hindsight migration and performance?" },
  { bankId: "user-knowledge", query: "How should Pi and OMP share memory data?" },
];

const baseline = [];
for (const item of queries) {
  const started = performance.now();
  try {
    const result = await request(`/v1/default/banks/${encodeURIComponent(item.bankId)}/memories/recall`, {
      method: "POST",
      body: JSON.stringify({
        query: item.query,
        budget: "mid",
        max_tokens: 1_024,
        types: ["observation"],
      }),
    });
    baseline.push({ ...item, durationMs: performance.now() - started, ok: true, result });
  } catch (error) {
    baseline.push({ ...item, durationMs: performance.now() - started, ok: false, error: String(error) });
  }
}

const snapshot = {
  createdAt: new Date().toISOString(),
  apiUrl,
  version,
  health,
  banks: bankSnapshots,
};

await writeFile(join(outputDir, "api-state.json"), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
await writeFile(join(outputDir, "baseline-recall.json"), `${JSON.stringify(baseline, null, 2)}\n`, { mode: 0o600 });

for (const bank of bankSnapshots) {
  console.log(`${bank.bank.bank_id}: documents=${bank.documentTotal} facts=${bank.stats.total_nodes} pages=${countNodes(bank.knowledgeTree.roots ?? [])}`);
}
for (const row of baseline) {
  const count = Array.isArray(row.result?.results) ? row.result.results.length : 0;
  console.log(`${row.bankId}: ${Math.round(row.durationMs)}ms ok=${row.ok} results=${count} query=${row.query}`);
}

function countNodes(nodes) {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0);
}
