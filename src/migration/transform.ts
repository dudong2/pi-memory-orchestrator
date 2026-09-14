import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface TransformArchiveOptions {
  sourceArchive: string;
  outputArchive: string;
  selectedDocumentIds: string[];
  scopeTag: string;
}

export interface TransformArchiveResult {
  sourceArchive: string;
  outputArchive: string;
  sourceBankId: string;
  scopeTag: string;
  selectedDocumentIds: string[];
  documentCount: number;
  factCount: number;
  sourceSha256: string;
  outputSha256: string;
}

interface TransferFact {
  metadata?: Record<string, string>;
  tags?: string[];
  observation_scopes?: string | string[][] | null;
  [key: string]: unknown;
}

interface TransferDocument {
  id: string;
  tags?: string[];
  facts?: TransferFact[];
  [key: string]: unknown;
}

function run(command: string, args: string[], cwd?: string): string {
  return execFileSync(command, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function validateArchiveEntries(entries: string[]): void {
  for (const entry of entries) {
    if (!entry || entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new Error(`unsafe archive entry: ${entry}`);
    }
  }
}

export async function transformArchive(options: TransformArchiveOptions): Promise<TransformArchiveResult> {
  try {
    await access(options.outputArchive);
    throw new Error(`output archive already exists: ${options.outputArchive}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entries = run("unzip", ["-Z1", options.sourceArchive]).split(/\r?\n/).filter(Boolean);
  validateArchiveEntries(entries);
  const temporary = await mkdtemp(join(tmpdir(), "pi-memory-migration-"));
  try {
    run("unzip", ["-q", options.sourceArchive, "-d", temporary]);
    const manifestPath = join(temporary, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    const sourceBankId = String(manifest.source_bank_id ?? "");
    if (!sourceBankId) throw new Error("source archive manifest has no source_bank_id");

    const selected = new Set(options.selectedDocumentIds);
    const documentsDir = join(temporary, "documents");
    const documentFiles = (await readdir(documentsDir)).filter((name) => name.endsWith(".json"));
    const kept: TransferDocument[] = [];
    for (const file of documentFiles) {
      const path = join(documentsDir, file);
      const document = JSON.parse(await readFile(path, "utf8")) as TransferDocument;
      if (!selected.has(document.id)) {
        await unlink(path);
        continue;
      }
      const legacyDocumentTags = document.tags ?? [];
      document.tags = [options.scopeTag];
      for (const fact of document.facts ?? []) {
        const legacyFactTags = fact.tags ?? [];
        fact.metadata = {
          ...(fact.metadata ?? {}),
          migration_source_bank: sourceBankId,
          migration_source_document: document.id,
          legacy_document_tags: JSON.stringify(legacyDocumentTags),
          legacy_fact_tags: JSON.stringify(legacyFactTags),
        };
        fact.tags = [options.scopeTag];
        fact.observation_scopes = [[options.scopeTag]];
        // Observations are intentionally omitted so the target scope can rebuild them.
        // A whole-bank export carries source consolidation lifecycle; retaining it would
        // mark these facts complete while their source observations no longer exist.
        delete fact.consolidated_at;
        delete fact.consolidation_failed_at;
      }
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      kept.push(document);
    }
    const missing = [...selected].filter((id) => !kept.some((document) => document.id === id));
    if (missing.length) throw new Error(`selected documents not found: ${missing.join(", ")}`);

    for (const entry of await readdir(temporary, { withFileTypes: true })) {
      if (entry.name === "manifest.json" || entry.name === "documents") continue;
      await rm(join(temporary, entry.name), { recursive: true, force: true });
    }
    const factCount = kept.reduce((sum, document) => sum + (document.facts?.length ?? 0), 0);
    Object.assign(manifest, {
      source_bank_id: sourceBankId,
      exported_at: new Date().toISOString(),
      document_count: kept.length,
      fact_count: factCount,
      observation_count: 0,
      archive_type: "documents",
      mental_model_count: 0,
      knowledge_page_count: 0,
      directive_count: 0,
      webhook_count: 0,
      includes_history: false,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rm(options.outputArchive, { force: true });
    run("zip", ["-q", "-r", resolve(options.outputArchive), "manifest.json", "documents"], temporary);

    return {
      sourceArchive: resolve(options.sourceArchive),
      outputArchive: resolve(options.outputArchive),
      sourceBankId,
      scopeTag: options.scopeTag,
      selectedDocumentIds: kept.map((document) => document.id).sort((a, b) => a.localeCompare(b)),
      documentCount: kept.length,
      factCount,
      sourceSha256: await sha256(options.sourceArchive),
      outputSha256: await sha256(options.outputArchive),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
