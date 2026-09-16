import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";

const [archivePath, bankId, conflict = "skip"] = process.argv.slice(2);
if (!archivePath || !bankId) throw new Error("usage: import-migration <archive.zip> <target-bank> [skip|replace|new-id]");
if (conflict !== "skip" && conflict !== "replace" && conflict !== "new-id") throw new Error("invalid conflict mode");
const config = loadConfig();
const connection = resolveHindsightConnection(config);
const client = new HindsightClient({ ...connection, requestTimeoutMs: 180_000 });
const archive = await readFile(archivePath);
const imported = await client.importDocuments(bankId, archive, basename(archivePath), conflict);
const importOperationId = typeof imported.operation_id === "string" ? imported.operation_id : undefined;
if (importOperationId) await waitForOperation(importOperationId, 300_000);
const consolidation = await client.triggerConsolidation(bankId);
const consolidationOperationId = typeof consolidation.operation_id === "string" ? consolidation.operation_id : undefined;
if (consolidationOperationId) await waitForOperation(consolidationOperationId, 300_000);
process.stdout.write(`${JSON.stringify({ imported, consolidation })}\n`);

async function waitForOperation(operationId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await client.operationStatus(bankId, operationId);
    const status = operation.status.toLowerCase();
    if (status === "completed") return;
    if (status === "failed" || status === "cancelled") throw new Error(`operation ${operationId} ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`operation ${operationId} timed out`);
}
