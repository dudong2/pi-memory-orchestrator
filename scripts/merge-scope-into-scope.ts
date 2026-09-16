import { basename, join } from "node:path";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { resolveAgentRoot } from "../src/hermes.js";
import { transformArchive } from "../src/migration/transform.js";
import { verifyTransformedArchive } from "../src/migration/verify.js";
import {
  catalogPath,
  loadScopeCatalog,
  qualifiedScopeName,
  removeScope,
} from "../src/scope/catalog.js";

interface ListResponse {
  items?: Array<{ id: string }>;
  memories?: Array<{ id?: string }>;
  total?: number;
}

interface ExportMetadata {
  download_url?: string;
  filename?: string;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const apply = process.argv.includes("--apply");
const sourceScopeId = argument("--source");
const targetScopeId = argument("--target");
const backupDir = argument("--backup");
const databaseBackup = join(backupDir, "hindsight-database.zip");
const config = loadConfig();
const connection = resolveHindsightConnection(config);
const apiUrl = connection.apiUrl.replace(/\/$/, "");
const headers: Record<string, string> = { Accept: "application/json" };
if (connection.apiToken)
  headers.Authorization = `Bearer ${connection.apiToken}`;
const bankId = config.mode === "shadow" ? config.shadowBankId : config.bankId;
const encodedBank = encodeURIComponent(bankId);
const client = new HindsightClient({
  ...connection,
  requestTimeoutMs: 180_000,
});
const catalog = await loadScopeCatalog(config.dataDir);
const source = catalog.scopes[sourceScopeId];
const target = catalog.scopes[targetScopeId];
if (!source) throw new Error(`unknown source Scope: ${sourceScopeId}`);
if (!target) throw new Error(`unknown target Scope: ${targetScopeId}`);
if (source.projectId !== target.projectId) {
  throw new Error("source and target Scopes must belong to the same Project");
}

async function jsonRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    throw new Error(
      `Hindsight ${init.method ?? "GET"} ${path} failed: ${response.status} ${text}`,
    );
  }
  return parsed as T;
}

async function list(
  path: "documents" | "memories/list",
  tag: string,
): Promise<ListResponse> {
  const query = new URLSearchParams({ tags_match: "all_strict", limit: "100" });
  query.append("tags", tag);
  return jsonRequest(
    `/v1/default/banks/${encodedBank}/${path}?${query.toString()}`,
  );
}

async function waitForOperation(operationId: string, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const operation = await client.operationStatus(bankId, operationId);
    const status = operation.status.toLowerCase();
    if (status === "completed") return operation;
    if (status === "failed" || status === "cancelled") {
      throw new Error(
        `operation ${operationId} ${status}: ${JSON.stringify(operation.error)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`operation ${operationId} timed out`);
}

async function blockingOperationCount(): Promise<number> {
  const response = await jsonRequest<{
    operations?: Array<{ status?: string; task_type?: string }>;
  }>(`/v1/default/banks/${encodedBank}/operations`);
  return (response.operations ?? []).filter((operation) => {
    if (operation.status === "failed") return true;
    if (!["pending", "processing"].includes(operation.status ?? ""))
      return false;
    return operation.task_type !== "refresh_mental_model";
  }).length;
}

const sourceDocuments = await list("documents", source.memoryTag);
const sourceMemories = await list("memories/list", source.memoryTag);
const targetDocuments = await list("documents", target.memoryTag);
const targetMemories = await list("memories/list", target.memoryTag);
const documentIds = (sourceDocuments.items ?? [])
  .map((document) => document.id)
  .sort();
const summary = {
  apply,
  bankId,
  source: qualifiedScopeName(catalog, source),
  target: qualifiedScopeName(catalog, target),
  sourceTag: source.memoryTag,
  targetTag: target.memoryTag,
  sourceDocuments: sourceDocuments.total ?? documentIds.length,
  sourceMemories: sourceMemories.total ?? sourceMemories.memories?.length ?? 0,
  targetDocuments: targetDocuments.total ?? targetDocuments.items?.length ?? 0,
  targetMemories: targetMemories.total ?? targetMemories.memories?.length ?? 0,
  documentIds,
  backupDir,
};
console.log(JSON.stringify(summary, null, 2));
if (!apply) process.exit(0);
if (await blockingOperationCount()) {
  throw new Error("Hindsight has blocking active or failed operations");
}
if (!(await exists(databaseBackup))) {
  throw new Error(`official database backup is missing: ${databaseBackup}`);
}
if (!documentIds.length)
  throw new Error("source Scope has no documents to migrate");

await mkdir(backupDir, { recursive: true, mode: 0o700 });
await cp(
  catalogPath(config.dataDir),
  join(backupDir, "scope-catalog.before.json"),
);
if (await exists(source.markerPath)) {
  await cp(source.markerPath, join(backupDir, "source-marker.before.json"));
}
const hermesDir = join(resolveAgentRoot(), "projects-memory", source.scopeId);
if (await exists(hermesDir)) {
  await cp(hermesDir, join(backupDir, "source-hermes-store"), {
    recursive: true,
  });
}

const exportSubmission = await jsonRequest<{ operation_id: string }>(
  `/v1/default/banks/${encodedBank}/document-transfer/export`,
  { method: "POST" },
);
const exportOperation = await waitForOperation(exportSubmission.operation_id);
const exportMetadata = (exportOperation.result_metadata ??
  {}) as ExportMetadata;
if (!exportMetadata.download_url)
  throw new Error("document export has no download URL");
const downloadUrl = new URL(exportMetadata.download_url, apiUrl).toString();
const archiveResponse = await fetch(downloadUrl, {
  headers,
  signal: AbortSignal.timeout(180_000),
});
if (!archiveResponse.ok)
  throw new Error(`document export download failed: ${archiveResponse.status}`);
const sourceArchive = join(backupDir, "source-bank-export.zip");
await writeFile(
  sourceArchive,
  new Uint8Array(await archiveResponse.arrayBuffer()),
  { mode: 0o600 },
);

const transformedArchive = join(backupDir, "moved-documents.zip");
const transformed = await transformArchive({
  sourceArchive,
  outputArchive: transformedArchive,
  selectedDocumentIds: documentIds,
  scopeTag: target.memoryTag,
});
const verified = await verifyTransformedArchive(
  transformedArchive,
  target.memoryTag,
);
const imported = await client.importDocuments(
  bankId,
  await readFile(transformedArchive),
  basename(transformedArchive),
  "replace",
);
if (typeof imported.operation_id === "string")
  await waitForOperation(imported.operation_id);
const consolidation = await client.triggerConsolidation(bankId);
if (typeof consolidation.operation_id === "string")
  await waitForOperation(consolidation.operation_id);

const oldDocuments = await list("documents", source.memoryTag);
const oldMemories = await list("memories/list", source.memoryTag);
const newDocuments = await list("documents", target.memoryTag);
const newMemories = await list("memories/list", target.memoryTag);
if ((oldDocuments.total ?? 0) !== 0 || (oldMemories.total ?? 0) !== 0) {
  throw new Error("source Scope still owns Hindsight documents or memories");
}
for (const documentId of documentIds) {
  const detail = await jsonRequest<{
    tags?: string[];
    observation_scopes?: string[][];
    retain_params?: { observation_scopes?: string[][] };
  }>(
    `/v1/default/banks/${encodedBank}/documents/${encodeURIComponent(documentId)}`,
  );
  const expected = JSON.stringify([[target.memoryTag]]);
  if (JSON.stringify(detail.tags) !== JSON.stringify([target.memoryTag])) {
    throw new Error(`document ${documentId} has incorrect tags`);
  }
  if (JSON.stringify(detail.observation_scopes) !== expected) {
    throw new Error(`document ${documentId} has incorrect observation scopes`);
  }
  if (JSON.stringify(detail.retain_params?.observation_scopes) !== expected) {
    throw new Error(
      `document ${documentId} has incorrect retained observation scopes`,
    );
  }
}

const tree = await client.knowledgeTree(bankId);
const project = source.projectId
  ? catalog.projects[source.projectId]
  : undefined;
const projectNode = tree.roots
  .find((node) => node.name === "Coding Projects")
  ?.children?.find(
    (node) => node.name === `${project?.name} [${project?.projectId}]`,
  );
const scopeNode = projectNode?.children?.find(
  (node) => node.name === `${source.name} [${source.scopeId}]`,
);
if (scopeNode) await client.deleteKnowledgeNode(bankId, scopeNode.id);

await removeScope(config.dataDir, source.scopeId);
await rm(source.markerPath, { force: true });
if (await exists(hermesDir)) {
  await rename(hermesDir, join(backupDir, "retired-hermes-store"));
}
const report = {
  ...summary,
  completedAt: new Date().toISOString(),
  transformed,
  verified,
  imported,
  consolidation,
  final: {
    sourceDocuments: oldDocuments.total ?? 0,
    sourceMemories: oldMemories.total ?? 0,
    targetDocuments: newDocuments.total ?? 0,
    targetMemories: newMemories.total ?? 0,
    removedKnowledgeNode: scopeNode?.id ?? null,
  },
};
await writeFile(
  join(backupDir, "migration-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(report.final, null, 2));
