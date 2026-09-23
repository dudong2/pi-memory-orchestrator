import { dirname } from "node:path";
import { loadConfig } from "../src/config.js";
import { ensureHermesScopeStore } from "../src/hermes.js";
import { loadScopeCatalog } from "../src/scope/catalog.js";
import { resolveScope } from "../src/scope/resolver.js";

const config = loadConfig();
const catalog = await loadScopeCatalog(config.dataDir);
const results: Array<{ scope: string; migrated: boolean }> = [];
for (const record of Object.values(catalog.scopes)) {
  const root = dirname(record.markerPath);
  const scope = await resolveScope(root, {
    dataDir: config.dataDir,
    markerName: config.markerName,
    startCwd: root,
  });
  if (!scope)
    throw new Error(`registered scope did not resolve: ${record.scopeId}`);
  const project = await ensureHermesScopeStore(scope);
  results.push({
    scope: project?.name ?? record.name,
    migrated: project !== null,
  });
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
