import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const hermesRoot =
  process.env.PI_HERMES_MEMORY_ROOT ?? "/tmp/pi-hermes-memory-audit";
const [
  { loadConfig },
  { MemoryStore },
  { DatabaseManager },
  { syncMemoryEntry },
] = await Promise.all([
  import(pathToFileURL(join(hermesRoot, "src/config.ts")).href),
  import(pathToFileURL(join(hermesRoot, "src/store/memory-store.ts")).href),
  import(pathToFileURL(join(hermesRoot, "src/store/db.ts")).href),
  import(
    pathToFileURL(join(hermesRoot, "src/store/sqlite-memory-store.ts")).href
  ),
]);

const [memoryDir, prefix, rawCount] = process.argv.slice(2);
if (!memoryDir || !prefix)
  throw new Error("usage: cross-runtime-worker <memory-dir> <prefix> [count]");
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
  if (!result.success)
    throw new Error(`${prefix} markdown add ${index}: ${result.error}`);
  syncMemoryEntry(db, { content, target: "memory", project: null });
  if (index % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
}

db.close();
console.log(`${prefix}: wrote ${count}`);
