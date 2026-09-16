import { join } from "node:path";
import { loadConfig, resolveHindsightConnection } from "../src/config.js";
import { HindsightClient } from "../src/hindsight/client.js";
import { ensureKnowledgeViews } from "../src/hindsight/knowledge.js";
import { resolveScope } from "../src/scope/resolver.js";

const cwd = process.argv[2];
if (!cwd) throw new Error("usage: live-knowledge-smoke <cwd>");
const config = loadConfig();
const connection = resolveHindsightConnection(config);
const client = new HindsightClient({ ...connection, requestTimeoutMs: config.requestTimeoutMs });
const scope = await resolveScope(cwd, {
  dataDir: config.dataDir,
  markerName: config.markerName,
});
if (!scope) throw new Error(`memory Scope is not registered: ${cwd}`);
const bankId = config.shadowBankId;
const first = await ensureKnowledgeViews(client, bankId, scope);
const second = await ensureKnowledgeViews(client, bankId, scope);
const tree = await client.knowledgeTree(bankId);
const names: string[] = [];
const visit = (nodes: typeof tree.roots) => {
  for (const node of nodes) {
    names.push(`${node.kind}:${node.name}`);
    visit(node.children ?? []);
  }
};
visit(tree.roots);
console.log(JSON.stringify({ first, second, names }));
if (second.createdFolders !== 0 || second.createdPages !== 0) process.exitCode = 1;
