import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJson } from "../json.js";

export interface ArchiveVerification {
  archiveSha256: string;
  sourceBankId: string;
  documentIds: string[];
  documentCount: number;
  factCount: number;
  scopeTag: string;
}

interface VerificationFact {
  tags?: string[];
  observation_scopes?: string[][];
  metadata?: Record<string, string>;
  consolidated_at?: string | null;
  consolidation_failed_at?: string | null;
}

interface VerificationDocument {
  id: string;
  tags?: string[];
  retain_params?: { observation_scopes?: string[][] };
  facts?: VerificationFact[];
}

function validateArchiveEntries(archivePath: string): void {
  const entries = execFileSync("unzip", ["-Z1", archivePath], {
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter(Boolean);
  if (
    entries.some(
      (entry) => entry.startsWith("/") || entry.split("/").includes(".."),
    )
  ) {
    throw new Error("archive contains unsafe paths");
  }
  if (
    entries.some(
      (entry) =>
        !entry.startsWith("documents/") &&
        entry !== "documents/" &&
        entry !== "manifest.json",
    )
  ) {
    throw new Error("transformed archive contains unsupported bank-level data");
  }
}

function validateFact(
  fact: VerificationFact,
  documentId: string,
  scopeTag: string,
): void {
  if (JSON.stringify(fact.tags) !== JSON.stringify([scopeTag]))
    throw new Error(`fact in ${documentId} has incorrect scope tags`);
  if (JSON.stringify(fact.observation_scopes) !== JSON.stringify([[scopeTag]]))
    throw new Error(`fact in ${documentId} has incorrect observation scope`);
  if (
    !fact.metadata?.migration_source_bank ||
    !fact.metadata.migration_source_document
  )
    throw new Error(`fact in ${documentId} lacks migration provenance`);
  if (fact.consolidated_at || fact.consolidation_failed_at)
    throw new Error(
      `fact in ${documentId} retains source consolidation lifecycle`,
    );
}

function validateDocument(
  document: VerificationDocument,
  scopeTag: string,
): number {
  if (JSON.stringify(document.tags) !== JSON.stringify([scopeTag]))
    throw new Error(`document ${document.id} has incorrect scope tags`);
  if (
    document.retain_params?.observation_scopes !== undefined &&
    JSON.stringify(document.retain_params.observation_scopes) !==
      JSON.stringify([[scopeTag]])
  ) {
    throw new Error(
      `document ${document.id} has incorrect retained observation scope`,
    );
  }
  const facts = document.facts ?? [];
  for (const fact of facts) validateFact(fact, document.id, scopeTag);
  return facts.length;
}

async function verifyExtractedArchive(
  temporary: string,
  archivePath: string,
  scopeTag: string,
): Promise<ArchiveVerification> {
  const manifestPath = join(temporary, "manifest.json");
  const manifest = parseJson<Record<string, unknown>>(
    await readFile(manifestPath, "utf8"),
    manifestPath,
  );
  const documentsDir = join(temporary, "documents");
  const files = (await readdir(documentsDir)).filter((name) =>
    name.endsWith(".json"),
  );
  const ids: string[] = [];
  let factCount = 0;
  for (const file of files) {
    const path = join(documentsDir, file);
    const document = parseJson<VerificationDocument>(
      await readFile(path, "utf8"),
      path,
    );
    ids.push(document.id);
    factCount += validateDocument(document, scopeTag);
  }
  if (
    Number(manifest.document_count) !== files.length ||
    Number(manifest.fact_count) !== factCount
  )
    throw new Error("manifest counts do not match transformed documents");
  return {
    archiveSha256: createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex"),
    sourceBankId: String(manifest.source_bank_id),
    documentIds: ids.sort((a, b) => a.localeCompare(b)),
    documentCount: files.length,
    factCount,
    scopeTag,
  };
}

export async function verifyTransformedArchive(
  archivePath: string,
  expectedScopeTag: string,
): Promise<ArchiveVerification> {
  validateArchiveEntries(archivePath);
  const temporary = await mkdtemp(join(tmpdir(), "pi-memory-verify-"));
  try {
    execFileSync("unzip", ["-q", archivePath, "-d", temporary]);
    return await verifyExtractedArchive(
      temporary,
      archivePath,
      expectedScopeTag,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
