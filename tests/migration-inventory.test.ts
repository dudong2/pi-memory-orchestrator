import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMigrationInventory } from "../src/migration/inventory.js";

async function inventoryFixture(root: string, count: number) {
  const source = join(root, "source");
  await mkdir(join(source, "documents"), { recursive: true });
  await writeFile(
    join(source, "manifest.json"),
    JSON.stringify({ source_bank_id: "user-knowledge" }),
  );
  for (let index = 0; index < count; index++) {
    const id =
      index === 0 ? "legacy-hermes-luckycat-copy" : `document-${index}`;
    const tags =
      index === 1
        ? ["legacy-reviewed", "migrated-curated-fact"]
        : index === 2
          ? ["migrated-curated-fact", "project:memory"]
          : ["migrated-curated-fact"];
    await writeFile(
      join(source, "documents", `${index}.json`),
      JSON.stringify({ id, tags, facts: [{ text: " Repeated Fact " }] }),
    );
  }
  await writeFile(
    join(source, "knowledge_pages.json"),
    JSON.stringify([{ id: "page", name: "overview", kind: "page" }]),
  );
  const archive = join(root, "bank.zip");
  execFileSync(
    "zip",
    ["-q", "-r", archive, "manifest.json", "documents", "knowledge_pages.json"],
    { cwd: source },
  );
  const invalidatedPath = join(root, "invalidated.json");
  await writeFile(
    invalidatedPath,
    JSON.stringify({
      banks: [
        {
          bankId: "user-knowledge",
          items: [{ id: "invalidated", text: "old" }],
        },
      ],
    }),
  );
  return {
    bankArchives: [archive],
    invalidatedPath,
    outputPath: join(root, "inventory.json"),
    scopeMappings: {
      "user-knowledge": { action: "import" as const, reason: "source bank" },
      "user-knowledge:project:memory": {
        action: "import" as const,
        scopeTag: "scope:test",
        reason: "explicit mapping",
      },
    },
  };
}

test("inventory preserves legacy decisions, invalidation, page regeneration, and cross-document duplicate counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-inventory-"));
  try {
    const options = await inventoryFixture(root, 201);
    const result = await buildMigrationInventory(options);
    const summary = result.summary as {
      documentActions: Record<string, number>;
      factActions: Record<string, number>;
      exactDuplicateGroups: number;
      activeFacts: number;
    };
    assert.deepEqual(summary.documentActions, {
      "preserve-only": 199,
      reject: 1,
      import: 1,
    });
    assert.deepEqual(summary.factActions, summary.documentActions);
    assert.equal(summary.exactDuplicateGroups, 1);
    assert.equal(summary.activeFacts, 201);
    const documents = result.documents as Array<{
      documentId: string;
      action: string;
      scopeTag?: string;
    }>;
    assert.equal(
      documents.find((document) => document.documentId === "document-1")
        ?.action,
      "preserve-only",
    );
    assert.equal(
      documents.find((document) => document.documentId === "document-2")
        ?.scopeTag,
      "scope:test",
    );
    assert.equal(
      (result.invalidated as Array<{ state: string; action: string }>)[0]
        ?.state,
      "invalidated",
    );
    assert.equal(
      (result.invalidated as Array<{ state: string; action: string }>)[0]
        ?.action,
      "preserve-only",
    );
    assert.equal(
      (result.knowledgePages as Array<{ action: string }>)[0]?.action,
      "regenerate",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory retains the historical snapshot document-count guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-inventory-count-"));
  try {
    const options = await inventoryFixture(root, 1);
    await assert.rejects(
      buildMigrationInventory(options),
      /expected 201 snapshot documents, found 1/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
