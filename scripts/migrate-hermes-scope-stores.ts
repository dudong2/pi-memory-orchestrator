import { loadConfig } from "../src/config.js";
import { ensureHermesScopeStore } from "../src/hermes.js";
import { loadScopeCatalog } from "../src/scope/catalog.js";
import { resolveRegisteredScope } from "./lib/scope.js";

const config = loadConfig();
const catalog = await loadScopeCatalog(config.dataDir);
const results: Array<{ scope: string; migrated: boolean }> = [];
for (const record of Object.values(catalog.scopes)) {
  const scope = await resolveRegisteredScope(record, config);
  const project = await ensureHermesScopeStore(scope);
  results.push({
    scope: project?.name ?? record.name,
    migrated: project !== null,
  });
}
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
