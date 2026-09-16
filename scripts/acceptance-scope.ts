import type { ResolvedScope, ScopeReference } from "../src/scope/resolver.js";

export const currentRepo = "github.com/dudong2/scope-current";
export const siblingRepo = "github.com/dudong2/scope-sibling";
const projectId = "project_acceptance";
const projectName = "acceptance";

const shared: ScopeReference = {
  scopeId: "scope_acceptance_shared",
  scopeName: "shared",
  qualifiedName: "acceptance/shared",
  aliases: [],
  projectId,
  projectName,
  projectAliases: [],
  memoryTag: "scope:id:scope_acceptance_shared",
  kind: "directory",
};
const current: ScopeReference = {
  scopeId: "scope_acceptance_current",
  scopeName: "scope-current",
  qualifiedName: "acceptance/scope-current",
  aliases: [],
  projectId,
  projectName,
  projectAliases: [],
  memoryTag: `scope:repo:${currentRepo}`,
  kind: "repository",
  repositoryId: currentRepo,
};
const sibling: ScopeReference = {
  scopeId: "scope_acceptance_sibling",
  scopeName: "scope-sibling",
  qualifiedName: "acceptance/scope-sibling",
  aliases: [],
  projectId,
  projectName,
  projectAliases: [],
  memoryTag: `scope:repo:${siblingRepo}`,
  kind: "repository",
  repositoryId: siblingRepo,
};
const knownScopes = [shared, current, sibling];

function resolved(reference: ScopeReference): ResolvedScope {
  return {
    workspaceRoot: `/acceptance/${reference.scopeName}`,
    markerPath: `/acceptance/${reference.scopeName}/.pi-memory-scope.json`,
    marker: {
      version: 2,
      scopeId: reference.scopeId,
      projectId,
      scopeName: reference.scopeName,
      kind: reference.kind,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    scopeId: reference.scopeId,
    scopeName: reference.scopeName,
    projectId,
    projectName,
    legacyHermesNames: [],
    workspaceTag: reference.memoryTag,
    ...(reference.repositoryId
      ? {
          repositoryId: reference.repositoryId,
          repositoryTag: reference.memoryTag,
        }
      : {}),
    git: null,
    scopeTag: reference.memoryTag,
    kind: reference.kind,
    ancestors: [],
    knownRepositoryIds: [currentRepo, siblingRepo],
    workspaceRepositoryIds: [currentRepo, siblingRepo],
    knownScopes,
    projectScopes: knownScopes,
  };
}

export const acceptanceScope = resolved(current);
export const sharedAcceptanceScope = resolved(shared);
export const siblingAcceptanceScope = resolved(sibling);
