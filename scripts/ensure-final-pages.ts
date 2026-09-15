import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { ensureKnowledgeViews } from "../src/hindsight/knowledge.js";
import { parseJson } from "../src/json.js";
import type { ResolvedScope } from "../src/scope/resolver.js";

const backup = process.argv[2];
if (!backup) throw new Error("usage: ensure-final-pages <backup-dir>");
const config = loadConfig();
const client = new HindsightClient({ ...resolveHindsightConnection(config), requestTimeoutMs: 30_000 });
const scopes = parseJson<{ resolved: Record<string, ResolvedScope> }>(
  await readFile(join(backup, "migrations", "scopes.json"), "utf8"),
  "migration scopes",
);
const results = [];
for (const name of ["orchestrator", "luckyCat", "memory"]) {
  const scope = scopes.resolved[name];
  if (!scope) throw new Error(`missing resolved scope: ${name}`);
  results.push({ name, result: await ensureKnowledgeViews(client, "coding-agent::dudong2", scope) });
}
console.log(JSON.stringify(results));
