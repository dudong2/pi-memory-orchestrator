import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "/tmp/pi-hermes-memory-audit/src/config.ts";
import { MemoryStore } from "/tmp/pi-hermes-memory-audit/src/store/memory-store.ts";
import { DatabaseManager } from "/tmp/pi-hermes-memory-audit/src/store/db.ts";
import { syncMemoryEntry } from "/tmp/pi-hermes-memory-audit/src/store/sqlite-memory-store.ts";

const [memoryDir, prefix, rawCount] = process.argv.slice(2);
if (!memoryDir || !prefix) throw new Error("usage: cross-runtime-worker <memory-dir> <prefix> [count]");
const count = Number(rawCount ?? 40);
await mkdir(memoryDir, { recursive: true });

const config = {
  ...loadConfig(join(memoryDir, "missing-config.json")),
  memoryDir,
  memoryMode: "legacy-inject" as const,
  memoryCharLimit: 1_000_000,
  memoryOverflowStrategy: "reject" as const,
  quickCheckOnOpen: false,
};
const store = new MemoryStore(config);
await store.loadFromDisk();
const db = new DatabaseManager(memoryDir);
db.setQuickCheckOnOpen(false);

for (let index = 0; index < count; index++) {
  const content = `${prefix}-entry-${index}`;
  const result = await store.add("memory", content);
  if (!result.success) throw new Error(`${prefix} markdown add ${index}: ${result.error}`);
  syncMemoryEntry(db, { content, target: "memory", project: null });
  if (index % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
}

db.close();
console.log(`${prefix}: wrote ${count}`);
