import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ArchiveVerification {
  archiveSha256: string;
  sourceBankId: string;
  documentIds: string[];
  documentCount: number;
  factCount: number;
  scopeTag: string;
}

export async function verifyTransformedArchive(archivePath: string, expectedScopeTag: string): Promise<ArchiveVerification> {
  const entries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  if (entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))) throw new Error("archive contains unsafe paths");
  if (entries.some((entry) => !entry.startsWith("documents/") && entry !== "documents/" && entry !== "manifest.json")) {
    throw new Error("transformed archive contains unsupported bank-level data");
  }
  const temporary = await mkdtemp(join(tmpdir(), "pi-memory-verify-"));
  try {
    execFileSync("unzip", ["-q", archivePath, "-d", temporary]);
    const manifest = JSON.parse(await readFile(join(temporary, "manifest.json"), "utf8")) as Record<string, unknown>;
    const files = (await readdir(join(temporary, "documents"))).filter((name) => name.endsWith(".json"));
    const ids: string[] = [];
    let factCount = 0;
    for (const file of files) {
      const document = JSON.parse(await readFile(join(temporary, "documents", file), "utf8")) as {
        id: string;
        tags?: string[];
        facts?: Array<{
          tags?: string[];
          observation_scopes?: string[][];
          metadata?: Record<string, string>;
          consolidated_at?: string | null;
          consolidation_failed_at?: string | null;
        }>;
      };
      ids.push(document.id);
      if (JSON.stringify(document.tags) !== JSON.stringify([expectedScopeTag])) throw new Error(`document ${document.id} has incorrect scope tags`);
      for (const fact of document.facts ?? []) {
        factCount++;
        if (JSON.stringify(fact.tags) !== JSON.stringify([expectedScopeTag])) throw new Error(`fact in ${document.id} has incorrect scope tags`);
        if (JSON.stringify(fact.observation_scopes) !== JSON.stringify([[expectedScopeTag]])) throw new Error(`fact in ${document.id} has incorrect observation scope`);
        if (!fact.metadata?.migration_source_bank || !fact.metadata.migration_source_document) throw new Error(`fact in ${document.id} lacks migration provenance`);
        if (fact.consolidated_at || fact.consolidation_failed_at) throw new Error(`fact in ${document.id} retains source consolidation lifecycle`);
      }
    }
    if (Number(manifest.document_count) !== files.length || Number(manifest.fact_count) !== factCount) {
      throw new Error("manifest counts do not match transformed documents");
    }
    return {
      archiveSha256: createHash("sha256").update(await readFile(archivePath)).digest("hex"),
      sourceBankId: String(manifest.source_bank_id),
      documentIds: ids.sort((a, b) => a.localeCompare(b)),
      documentCount: files.length,
      factCount,
      scopeTag: expectedScopeTag,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
