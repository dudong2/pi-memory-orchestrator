import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { RetainOutbox } from "../src/hindsight/outbox.js";
import { ScopedHindsightProvider } from "../src/hindsight/provider.js";
import { parseJson } from "../src/json.js";
import type { ResolvedScope } from "../src/scope/resolver.js";

const backup = process.argv[2];
if (!backup) throw new Error("usage: final-recall-smoke <backup-dir>");
const base = loadConfig();
const config = {
  ...base,
  mode: "active" as const,
  recallTypes: ["observation", "world", "experience"] as Array<
    "observation" | "world" | "experience"
  >,
  preferObservations: true,
};
const client = new HindsightClient({
  ...resolveHindsightConnection(config),
  requestTimeoutMs: 30_000,
});
const provider = new ScopedHindsightProvider(
  config,
  client,
  new RetainOutbox({ rootDir: join(config.dataDir, "final-smoke-outbox") }),
);
const scopes = parseJson<{ resolved: Record<string, ResolvedScope> }>(
  await readFile(join(backup, "migrations", "scopes.json"), "utf8"),
  "migration scopes",
);
function requiredScope(name: string): ResolvedScope {
  const resolved = scopes.resolved[name];
  if (!resolved) throw new Error(`missing resolved scope: ${name}`);
  return resolved;
}

const cases = [
  {
    name: "LuckyCat no-fill",
    scope: requiredScope("luckyCat"),
    query: "What is the verified LuckyCat no-fill scope rule?",
    expected: ["no-fill"],
  },
  {
    name: "LuckyCat walking",
    scope: requiredScope("luckyCat"),
    query: "What is the walking_booster_x10 QA convention?",
    expected: ["walking_booster_x10"],
  },
  {
    name: "orchestrator",
    scope: requiredScope("orchestrator"),
    query: "How does the memory orchestrator use Hindsight tag_groups?",
    expected: ["tag_groups"],
  },
  {
    name: "memory",
    scope: requiredScope("memory"),
    query:
      "What Hindsight bank scoping rules were learned in the memory workspace?",
    expected: ["Hindsight", "bank"],
  },
];
const results = await Promise.all(
  cases.map(async (item) => {
    const started = performance.now();
    const outcome = await provider.recall(item.query, item.scope);
    const text = outcome.memories
      .map((memory) => memory.text)
      .join("\n")
      .toLowerCase();
    return {
      name: item.name,
      durationMs: performance.now() - started,
      count: outcome.memories.length,
      ok:
        !outcome.error &&
        item.expected.every((token) => text.includes(token.toLowerCase())),
      error: outcome.error,
    };
  }),
);
process.stdout.write(
  `${JSON.stringify(
    results.map((item) => ({
      ...item,
      durationMs: Math.round(item.durationMs),
    })),
  )}\n`,
);
if (results.some((item) => !item.ok || item.durationMs > 5_000))
  process.exitCode = 1;
