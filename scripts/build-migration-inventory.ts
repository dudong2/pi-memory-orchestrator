import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMigrationInventory, type ScopeMapping } from "../src/migration/inventory.js";
import { parseJson } from "../src/json.js";

const backup = process.argv[2];
if (!backup) throw new Error("usage: build-migration-inventory <backup-dir>");
const scopes = parseJson<{ mappings: Record<string, ScopeMapping> }>(
  await readFile(join(backup, "migrations", "scopes.json"), "utf8"),
  "migration scopes",
);
const bankDir = join(backup, "banks");
const inventory = await buildMigrationInventory({
  bankArchives: [
    join(bankDir, "coding-agent__scratch.zip"),
    join(bankDir, "coding-agent__certen-io.zip"),
    join(bankDir, "coding-agent__memory.zip"),
    join(bankDir, "coding-agent__LuckyCat.zip"),
    join(bankDir, "user-knowledge.zip"),
  ],
  invalidatedPath: join(backup, "invalidated-memories.json"),
  scopeMappings: scopes.mappings,
  outputPath: join(backup, "migrations", "inventory.json"),
});
console.log(JSON.stringify(inventory.summary));
