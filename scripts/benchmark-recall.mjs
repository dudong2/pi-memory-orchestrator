import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const [label, outputPath, baselinePath] = process.argv.slice(2);
if (!label || !outputPath || !baselinePath) {
  throw new Error("usage: node scripts/benchmark-recall.mjs <label> <output.json> <baseline.json>");
}

const client = JSON.parse(readFileSync(`${process.env.HOME}/.hindsight/coding-agent.json`, "utf8"));
const endpoint = process.env.SIDECAR_API_URL ?? "http://127.0.0.1:18911";
const headers = { Authorization: `Bearer ${client.apiToken}`, "Content-Type": "application/json" };
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const querySet = baseline.map(({ bankId, query }) => ({ bankId, query }));

async function waitUntilHealthy() {
  const deadline = Date.now() + 120_000;
  let lastError = "not started";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`, { headers, signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`sidecar did not become healthy: ${lastError}`);
}

async function recall(item) {
  const started = performance.now();
  try {
    const response = await fetch(`${endpoint}/v1/default/banks/${encodeURIComponent(item.bankId)}/memories/recall`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: item.query, budget: "mid", max_tokens: 1_024, types: ["observation"] }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    return {
      ...item,
      ok: response.ok,
      status: response.status,
      durationMs: performance.now() - started,
      results: body.results ?? [],
      error: response.ok ? undefined : body,
    };
  } catch (error) {
    return { ...item, ok: false, durationMs: performance.now() - started, results: [], error: String(error) };
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

function resultIdentity(result) {
  return String(result.id ?? result.memory_id ?? result.text ?? "").trim();
}

function topOverlap(current, original, limit = 5) {
  const expected = new Set((original?.result?.results ?? []).slice(0, limit).map(resultIdentity));
  if (!expected.size) return null;
  const actual = current.slice(0, limit).map(resultIdentity);
  return actual.filter((id) => expected.has(id)).length / expected.size;
}

async function readCredits() {
  const key = process.env.HINDSIGHT_API_RERANKER_OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? await response.json() : { status: response.status };
  } catch (error) {
    return { error: String(error) };
  }
}

await waitUntilHealthy();
await recall(querySet[0]);
const creditsBefore = await readCredits();
const sequential = [];
for (let repeat = 0; repeat < 3; repeat++) {
  for (const query of querySet) sequential.push(await recall(query));
}
const concurrent = [];
for (let round = 0; round < 3; round++) {
  const group = querySet.slice(0, 4);
  concurrent.push(...await Promise.all(group.map(recall)));
}
const creditsAfter = await readCredits();

const successful = [...sequential, ...concurrent].filter((row) => row.ok);
const durations = successful.map((row) => row.durationMs);
const overlaps = sequential.map((row) => {
  const original = baseline.find((item) => item.bankId === row.bankId && item.query === row.query);
  return topOverlap(row.results, original);
}).filter((value) => value !== null);

const report = {
  label,
  createdAt: new Date().toISOString(),
  endpoint,
  requestCount: sequential.length + concurrent.length + 1,
  metrics: {
    successful: successful.length,
    failed: sequential.length + concurrent.length - successful.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length ? Math.max(...durations) : null,
    meanTop5Overlap: overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : null,
  },
  creditsBefore,
  creditsAfter,
  sequential,
  concurrent,
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report.metrics));
