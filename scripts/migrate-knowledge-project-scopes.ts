import { dirname } from "node:path";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { ensureKnowledgeViews } from "../src/hindsight/knowledge.js";
import { loadScopeCatalog } from "../src/scope/catalog.js";
import { resolveScope } from "../src/scope/resolver.js";

const apply = process.argv.includes("--apply");
const config = loadConfig();
const client = new HindsightClient({
  ...resolveHindsightConnection(config),
  requestTimeoutMs: config.requestTimeoutMs,
});
const bankId = config.mode === "shadow" ? config.shadowBankId : config.bankId;
const catalog = await loadScopeCatalog(config.dataDir);
const initial = await client.knowledgeTree(bankId);
const legacy = initial.roots.find(
  (node) => node.kind === "folder" && node.name === "Coding Workspaces",
);
console.log(
  JSON.stringify({
    apply,
    bankId,
    scopes: Object.keys(catalog.scopes).length,
    legacyRoot: legacy?.id ?? null,
  }),
);
if (!apply) process.exit(0);

let createdFolders = 0;
let createdPages = 0;
for (const record of Object.values(catalog.scopes)) {
  const root = dirname(record.markerPath);
  const scope = await resolveScope(root, {
    dataDir: config.dataDir,
    markerName: config.markerName,
    startCwd: root,
  });
  if (!scope)
    throw new Error(`registered scope did not resolve: ${record.scopeId}`);
  const result = await ensureKnowledgeViews(client, bankId, scope);
  createdFolders += result.createdFolders;
  createdPages += result.createdPages;
}
const updated = await client.knowledgeTree(bankId);
const projectRoot = updated.roots.find(
  (node) => node.kind === "folder" && node.name === "Coding Projects",
);
if (!projectRoot) throw new Error("Coding Projects root was not created");
if (legacy) await client.deleteKnowledgeNode(bankId, legacy.id);
console.log(
  JSON.stringify({
    createdFolders,
    createdPages,
    projectRoot: projectRoot.id,
    removedLegacyRoot: legacy?.id ?? null,
  }),
);
