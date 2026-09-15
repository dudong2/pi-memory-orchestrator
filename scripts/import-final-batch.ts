import { basename, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { parseJson } from "../src/json.js";

const backup = process.argv[2];
if (!backup) throw new Error("usage: import-final-batch <backup-dir>");
const manifest = parseJson<{
  targetBank: string;
  results: Array<{ outputArchive: string; bankId: string; scopeTag: string }>;
}>(await readFile(join(backup, "migrations", "final-import-batch.json"), "utf8"), "final import batch");
const config = loadConfig();
const client = new HindsightClient({ ...resolveHindsightConnection(config), requestTimeoutMs: 180_000 });
const imports = [];
for (const item of manifest.results) {
  const archive = await readFile(item.outputArchive);
  const response = await client.importDocuments(manifest.targetBank, archive, basename(item.outputArchive), "skip");
  if (typeof response.operation_id === "string") await wait(response.operation_id, 300_000);
  imports.push({ bankId: item.bankId, scopeTag: item.scopeTag, response });
}
const consolidation = await client.triggerConsolidation(manifest.targetBank);
if (typeof consolidation.operation_id === "string") await wait(consolidation.operation_id, 900_000);
const result = { version: 1, createdAt: new Date().toISOString(), targetBank: manifest.targetBank, imports, consolidation };
const output = join(backup, "migrations", "final-import-result.json");
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ targetBank: manifest.targetBank, importGroups: imports.length, consolidation: "completed" }));

async function wait(operationId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await client.operationStatus(manifest.targetBank, operationId);
    const status = operation.status.toLowerCase();
    if (status === "completed") return;
    if (status === "failed" || status === "cancelled") throw new Error(`operation ${operationId} ${status}: ${JSON.stringify(operation.error ?? "")}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`operation ${operationId} timed out`);
}
