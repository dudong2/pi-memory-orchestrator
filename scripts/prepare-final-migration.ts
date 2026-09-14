import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transformArchive } from "../src/migration/transform.js";
import { verifyTransformedArchive } from "../src/migration/verify.js";

const backup = process.argv[2];
if (!backup) throw new Error("usage: prepare-final-migration <backup-dir>");
const migrationDir = join(backup, "migrations");
const inventory = JSON.parse(await readFile(join(migrationDir, "inventory.json"), "utf8")) as {
  documents: Array<{ bankId: string; documentId: string; action: string; scopeTag?: string }>;
};
const archives: Record<string, string> = {
  "coding-agent::scratch": "coding-agent__scratch.zip",
  "coding-agent::memory": "coding-agent__memory.zip",
  "coding-agent::LuckyCat": "coding-agent__LuckyCat.zip",
  "user-knowledge": "user-knowledge.zip",
};
const grouped = new Map<string, typeof inventory.documents>();
for (const document of inventory.documents.filter((item) => item.action === "import")) {
  if (!document.scopeTag) throw new Error(`import document has no scope: ${document.bankId}/${document.documentId}`);
  const key = `${document.bankId}\u0000${document.scopeTag}`;
  grouped.set(key, [...(grouped.get(key) ?? []), document]);
}
const results = [];
for (const [key, documents] of grouped) {
  const [bankId, scopeTag] = key.split("\u0000");
  if (!bankId || !scopeTag) throw new Error(`invalid migration group: ${key}`);
  const sourceName = archives[bankId];
  if (!sourceName) throw new Error(`no source archive for ${bankId}`);
  const safe = bankId.replace(/[^a-zA-Z0-9._-]+/g, "_");
  const outputArchive = join(migrationDir, `final-${safe}.zip`);
  const result = await transformArchive({
    sourceArchive: join(backup, "banks", sourceName),
    outputArchive,
    selectedDocumentIds: documents.map((item) => item.documentId),
    scopeTag,
  });
  const verification = await verifyTransformedArchive(outputArchive, scopeTag);
  results.push({ bankId, scopeTag, outputArchive, result, verification });
}
const manifestPath = join(migrationDir, "final-import-batch.json");
await writeFile(manifestPath, `${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), targetBank: "coding-agent::dudong2", results }, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ groups: results.length, documents: results.reduce((sum, item) => sum + item.verification.documentCount, 0), facts: results.reduce((sum, item) => sum + item.verification.factCount, 0) }));
