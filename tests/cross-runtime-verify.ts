import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "/tmp/pi-hermes-memory-audit/src/config.ts";
import { MemoryStore } from "/tmp/pi-hermes-memory-audit/src/store/memory-store.ts";
import { DatabaseManager } from "/tmp/pi-hermes-memory-audit/src/store/db.ts";

const memoryDir = process.env.TEST_DIR;
if (!memoryDir) throw new Error("TEST_DIR is required");

const config = {
  ...loadConfig(join(memoryDir, "missing-config.json")),
  memoryDir,
  memoryMode: "legacy-inject" as const,
  memoryCharLimit: 1_000_000,
  quickCheckOnOpen: false,
};
const store = new MemoryStore(config);
await store.loadFromDisk();
const entries = store.getMemoryEntries();
const uniqueEntries = new Set(entries);

const manager = new DatabaseManager(memoryDir);
manager.setQuickCheckOnOpen(false);
const db = manager.getDb() as unknown as {
  prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> };
};
const row = db.prepare("SELECT count(*) AS count FROM memories WHERE content LIKE '%-entry-%'").get();
const integrity = db.prepare("PRAGMA integrity_check").get();
manager.close();

const files = await readdir(memoryDir);
const conflicts = files.filter((name) => name.includes("conflict"));
assert.equal(entries.length, 80, "all Markdown entries must survive concurrent writers");
assert.equal(uniqueEntries.size, 80, "Markdown entries must be unique");
assert.equal(Number(row.count), 80, "all SQLite rows must survive concurrent writers");
assert.equal(String(Object.values(integrity)[0]), "ok", "SQLite integrity_check must pass");
assert.deepEqual(conflicts, [], "no conflict recovery files should be created");
console.log(`markdown=${entries.length} sqlite=${row.count} integrity=ok conflicts=0`);
