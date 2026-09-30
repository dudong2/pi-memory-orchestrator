import { dirname } from "node:path";
import type { OrchestratorConfig } from "../../src/config.js";
import type { ScopeRecord } from "../../src/scope/catalog.js";
import { resolveScope, type ResolvedScope } from "../../src/scope/resolver.js";

export async function resolveRegisteredScope(
  record: ScopeRecord,
  config: Pick<OrchestratorConfig, "dataDir" | "markerName">,
): Promise<ResolvedScope> {
  const root = dirname(record.markerPath);
  const scope = await resolveScope(root, {
    dataDir: config.dataDir,
    markerName: config.markerName,
    startCwd: root,
  });
  if (!scope)
    throw new Error(`registered scope did not resolve: ${record.scopeId}`);
  return scope;
}
