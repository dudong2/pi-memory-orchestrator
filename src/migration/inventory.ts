import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

export type MigrationAction =
  | "import"
  | "preserve-only"
  | "reject"
  | "regenerate";

export interface ScopeMapping {
  action: MigrationAction;
  scopeTag?: string;
  reason: string;
}

export interface InventoryOptions {
  bankArchives: string[];
  invalidatedPath: string;
  scopeMappings: Record<string, ScopeMapping>;
  outputPath: string;
}

interface ArchiveDocument {
  id: string;
  tags?: string[];
  facts?: Array<{ text?: string; tags?: string[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

function unzip(archive: string, args: string[]): string {
  return execFileSync("unzip", [...args, archive], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseJson<T>(content: string, source: string): T {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    throw new Error(`invalid JSON in ${source}: ${String(error)}`, {
      cause: error,
    });
  }
}

function readArchiveEntry<T>(archive: string, entry: string): T {
  const content = execFileSync("unzip", ["-p", archive, entry], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseJson<T>(content, `${archive}:${entry}`);
}

function decideDocument(
  bankId: string,
  document: ArchiveDocument,
  mappings: Record<string, ScopeMapping>,
): ScopeMapping {
  const tags = new Set(document.tags ?? []);
  if (bankId === "coding-agent::LuckyCat") {
    if ((document.facts?.length ?? 0) === 0)
      return { action: "reject", reason: "factless survey completion marker" };
    return (
      mappings[bankId] ?? {
        action: "preserve-only",
        reason: "missing LuckyCat scope mapping",
      }
    );
  }
  if (bankId === "coding-agent::scratch" || bankId === "coding-agent::memory") {
    return (
      mappings[bankId] ?? {
        action: "preserve-only",
        reason: "missing local workspace mapping",
      }
    );
  }
  if (bankId === "coding-agent::certen-io") {
    return (
      mappings[bankId] ?? {
        action: "preserve-only",
        reason: "unresolved local workspace",
      }
    );
  }
  if (bankId === "user-knowledge") {
    if (
      document.id.startsWith("legacy-hermes-luckycat-") ||
      document.id.startsWith("verified-correction-no-fill-scope")
    ) {
      return {
        action: "reject",
        reason: "duplicate of the verified LuckyCat source-bank document",
      };
    }
    if (
      tags.has("historical-claim") ||
      tags.has("legacy-reviewed") ||
      tags.has("reviewed-eviction")
    ) {
      return {
        action: "preserve-only",
        reason:
          "historical or reviewed legacy claim is not independently current-verified",
      };
    }
    if (tags.has("migrated-curated-fact") && tags.has("project:memory")) {
      return (
        mappings["user-knowledge:project:memory"] ?? {
          action: "preserve-only",
          reason: "missing memory workspace mapping",
        }
      );
    }
    if (tags.has("migrated-curated-fact")) {
      return {
        action: "preserve-only",
        reason:
          "global curated fact remains in bounded local/global archive policy",
      };
    }
    return {
      action: "preserve-only",
      reason: "unscoped global/session data has no safe workspace assignment",
    };
  }
  return { action: "preserve-only", reason: "unknown source bank" };
}

function normalizedFact(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function buildMigrationInventory(
  options: InventoryOptions,
): Promise<Record<string, unknown>> {
  const documents: Array<Record<string, unknown>> = [];
  const pages: Array<Record<string, unknown>> = [];
  const factLocations = new Map<
    string,
    Array<{ bankId: string; documentId: string; index: number }>
  >();

  for (const archive of options.bankArchives) {
    const manifest = readArchiveEntry<Record<string, unknown>>(
      archive,
      "manifest.json",
    );
    const bankId = String(manifest.source_bank_id ?? "");
    if (!bankId) throw new Error(`archive has no source bank: ${archive}`);
    const entries = unzip(archive, ["-Z1"]).split(/\r?\n/).filter(Boolean);
    for (const entry of entries.filter(
      (name) => name.startsWith("documents/") && name.endsWith(".json"),
    )) {
      const document = readArchiveEntry<ArchiveDocument>(archive, entry);
      const decision = decideDocument(bankId, document, options.scopeMappings);
      const facts = document.facts ?? [];
      documents.push({
        bankId,
        archive: basename(archive),
        documentId: document.id,
        tags: document.tags ?? [],
        factCount: facts.length,
        state: "active",
        action: decision.action,
        reason: decision.reason,
        ...(decision.scopeTag ? { scopeTag: decision.scopeTag } : {}),
        sourceSha256: createHash("sha256")
          .update(JSON.stringify(document))
          .digest("hex"),
      });
      facts.forEach((fact, index) => {
        const normalized = normalizedFact(String(fact.text ?? ""));
        if (!normalized) return;
        const hash = createHash("sha256").update(normalized).digest("hex");
        factLocations.set(hash, [
          ...(factLocations.get(hash) ?? []),
          { bankId, documentId: document.id, index },
        ]);
      });
    }
    if (entries.includes("knowledge_pages.json")) {
      const sourcePages = readArchiveEntry<Array<Record<string, unknown>>>(
        archive,
        "knowledge_pages.json",
      );
      for (const page of sourcePages) {
        const mapping = options.scopeMappings[bankId];
        pages.push({
          bankId,
          id: page.id,
          name: page.name,
          kind: page.kind,
          action: mapping?.action === "import" ? "regenerate" : "preserve-only",
          reason:
            mapping?.action === "import"
              ? "recreate from scope-filtered source facts in the shared bank"
              : "source bank is not imported",
        });
      }
    }
  }

  const invalidatedContent = await readFile(options.invalidatedPath, "utf8");
  const invalidatedSource = parseJson<{
    banks?: Array<{
      bankId: string;
      items: Array<{ id?: string; text?: string; [key: string]: unknown }>;
    }>;
  }>(invalidatedContent, options.invalidatedPath);
  const invalidated = (invalidatedSource.banks ?? []).flatMap((bank) =>
    bank.items.map((item) => ({
      bankId: bank.bankId,
      memoryId: item.id,
      state: "invalidated",
      action: "preserve-only",
      reason:
        "invalidated source history is retained for audit and is not made recall-visible",
      sourceSha256: createHash("sha256")
        .update(JSON.stringify(item))
        .digest("hex"),
    })),
  );
  const duplicateGroups = [...factLocations.entries()].flatMap(
    ([normalizedSha256, locations]) =>
      locations.length > 1 ? [{ normalizedSha256, locations }] : [],
  );

  const actionCounts = documents.reduce<Record<string, number>>(
    (counts, document) => {
      const action = String(document.action);
      counts[action] = (counts[action] ?? 0) + 1;
      return counts;
    },
    {},
  );
  const factCounts = documents.reduce<Record<string, number>>(
    (counts, document) => {
      const action = String(document.action);
      counts[action] = (counts[action] ?? 0) + Number(document.factCount);
      return counts;
    },
    {},
  );
  const inventory = {
    version: 1,
    createdAt: new Date().toISOString(),
    policy: {
      finalBank: "coding-agent::dudong2",
      globalFacts: "bounded-local-only",
      sourceBanksAreImmutable: true,
    },
    summary: {
      documents: documents.length,
      documentActions: actionCounts,
      activeFacts: documents.reduce(
        (sum, document) => sum + Number(document.factCount),
        0,
      ),
      factActions: factCounts,
      invalidated: invalidated.length,
      knowledgePages: pages.length,
      exactDuplicateGroups: duplicateGroups.length,
    },
    documents,
    invalidated,
    knowledgePages: pages,
    duplicateGroups,
  };
  if (documents.length !== 201)
    throw new Error(
      `expected 201 snapshot documents, found ${documents.length}`,
    );
  await writeFile(
    options.outputPath,
    `${JSON.stringify(inventory, null, 2)}\n`,
    { mode: 0o600 },
  );
  return inventory;
}
