import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { updateScopeIndex } from "../src/scope/marker.js";
import { resolveScope } from "../src/scope/resolver.js";

const output = process.argv[2];
if (!output) throw new Error("usage: prepare-migration-scopes <output.json>");
const config = loadConfig();
const paths = {
  orchestrator: "/Users/dudong2/workspace/github.com/dudong2/pi-memory-orchestrator",
  scratch: "/Users/dudong2/workspace/github.com/dudong2/scratch",
  luckyCat: "/Users/dudong2/workspace/github.com/dudong2/LuckyCat/LuckyCat",
  memory: "/Users/dudong2/workspace/github.com/dudong2/memory",
};
const orchestrator = await resolveScope(paths.orchestrator, { dataDir: config.dataDir });
await updateScopeIndex(
  join(config.dataDir, "scope-index.json"),
  orchestrator.markerPath,
  orchestrator.marker,
  paths.scratch,
);
const scratch = await resolveScope(paths.scratch, { dataDir: config.dataDir });
const luckyCat = await resolveScope(paths.luckyCat, { dataDir: config.dataDir });
const memory = await resolveScope(paths.memory, { dataDir: config.dataDir });
const scopes = {
  version: 1,
  createdAt: new Date().toISOString(),
  mappings: {
    "coding-agent::scratch": {
      action: "import",
      scopeTag: orchestrator.workspaceTag,
      reason: "Temporary planning directory mapped to the stable pi-memory-orchestrator workspace",
      resolvedScratchRepository: scratch.repositoryId,
    },
    "coding-agent::LuckyCat": {
      action: "import",
      scopeTag: luckyCat.repositoryTag,
      reason: "Canonical LuckyCat repository scope",
    },
    "coding-agent::memory": {
      action: "import",
      scopeTag: memory.workspaceTag,
      reason: "Local non-Git memory research workspace",
    },
    "user-knowledge:project:memory": {
      action: "import",
      scopeTag: memory.workspaceTag,
      reason: "Curated records explicitly attributed to the memory workspace",
    },
    "coding-agent::certen-io": {
      action: "preserve-only",
      reason: "No unambiguous current local workspace or canonical Git remote mapping",
    },
  },
  resolved: {
    orchestrator,
    scratch,
    luckyCat,
    memory,
  },
};
await writeFile(output, `${JSON.stringify(scopes, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(Object.fromEntries(Object.entries(scopes.mappings).map(([key, value]) => [key, value.action]))));
