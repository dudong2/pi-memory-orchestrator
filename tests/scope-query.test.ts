import assert from "node:assert/strict";
import test from "node:test";
import { buildScopeQueryPlan, GLOBAL_SCOPE_TAG, hasWorkspaceWideIntent } from "../src/scope/query.js";
import type { ResolvedScope } from "../src/scope/resolver.js";

const scope: ResolvedScope = {
  workspaceRoot: "/work/product",
  markerPath: "/work/product/.pi-memory-scope.json",
  marker: {
    version: 1,
    workspaceId: "ws_11111111-1111-4111-8111-111111111111",
    displayName: "product",
    repositories: [
      "github.com/dudong2/backend",
      "github.com/dudong2/frontend",
      "github.com/dudong2/infrastructure",
    ],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
  workspaceTag: "scope:workspace:ws_11111111-1111-4111-8111-111111111111",
  repositoryId: "github.com/dudong2/frontend",
  repositoryTag: "scope:repo:github.com/dudong2/frontend",
  git: null,
  scopeTag: "scope:repo:github.com/dudong2/frontend",
  kind: "repository",
  ancestors: [{
    root: "/work/product",
    markerPath: "/work/product/.pi-memory-scope.json",
    marker: {
      version: 1,
      workspaceId: "ws_11111111-1111-4111-8111-111111111111",
      displayName: "product",
      repositories: [],
      createdAt: "2026-09-14T00:00:00.000Z",
      updatedAt: "2026-09-14T00:00:00.000Z",
    },
    kind: "workspace",
    tag: "scope:workspace:ws_11111111-1111-4111-8111-111111111111",
  }],
  knownRepositoryIds: [
    "github.com/dudong2/backend",
    "github.com/dudong2/frontend",
    "github.com/dudong2/infrastructure",
  ],
  workspaceRepositoryIds: [
    "github.com/dudong2/backend",
    "github.com/dudong2/frontend",
    "github.com/dudong2/infrastructure",
  ],
};

test("default plan includes global, workspace, and current repo but no sibling", () => {
  const plan = buildScopeQueryPlan(scope, "Fix the login screen");
  assert.deepEqual(plan.tags, [GLOBAL_SCOPE_TAG, scope.workspaceTag, scope.repositoryTag]);
  assert.deepEqual(plan.expandedRepositories, []);
  assert.deepEqual(plan.tagGroups, [{ or: [
    { tags: [GLOBAL_SCOPE_TAG], match: "all_strict" },
    { tags: [scope.workspaceTag], match: "all_strict" },
    { tags: [scope.repositoryTag], match: "all_strict" },
  ] }]);
});

test("mentioning a sibling expands only that repository", () => {
  const plan = buildScopeQueryPlan(scope, "How did backend solve authentication?");
  assert.deepEqual(plan.expandedRepositories, ["github.com/dudong2/backend"]);
  assert.ok(plan.tags.includes("scope:repo:github.com/dudong2/backend"));
  assert.ok(!plan.tags.includes("scope:repo:github.com/dudong2/infrastructure"));
});

test("repository lookup treats hyphens and underscores as aliases", () => {
  const plan = buildScopeQueryPlan({
    ...scope,
    knownRepositoryIds: [...scope.knownRepositoryIds, "github.com/dudong2/auto_trading"],
  }, "What failed in auto-trading?");
  assert.ok(plan.tags.includes("scope:repo:github.com/dudong2/auto_trading"));
});

test("workspace-wide intent expands all child repositories", () => {
  assert.equal(hasWorkspaceWideIntent("전체 저장소 구조를 비교해줘"), true);
  const plan = buildScopeQueryPlan(scope, "Compare all repositories");
  assert.equal(plan.workspaceWide, true);
  assert.equal(plan.tags.length, 5);
  assert.deepEqual(plan.expandedRepositories, [
    "github.com/dudong2/backend",
    "github.com/dudong2/infrastructure",
  ]);
});

test("workspace mode excludes every repository but keeps global knowledge", () => {
  const plan = buildScopeQueryPlan(scope, "shared conventions", { mode: "workspace" });
  assert.deepEqual(plan.tags, [GLOBAL_SCOPE_TAG, scope.workspaceTag]);
});

test("a global marker searches only the shared global scope", () => {
  const globalScope: ResolvedScope = {
    ...scope,
    marker: { ...scope.marker, scope: "global", displayName: "scratchpad", repositories: [] },
    repositoryId: undefined,
    repositoryTag: undefined,
    scopeTag: GLOBAL_SCOPE_TAG,
    kind: "global",
    ancestors: [],
    knownRepositoryIds: [],
    workspaceRepositoryIds: [],
  };
  const plan = buildScopeQueryPlan(globalScope, "general knowledge");
  assert.deepEqual(plan.tags, [GLOBAL_SCOPE_TAG]);
  assert.deepEqual(plan.tagGroups, [{ or: [
    { tags: [GLOBAL_SCOPE_TAG], match: "all_strict" },
  ] }]);
});

test("explicit repository mode ignores unknown repository IDs", () => {
  const plan = buildScopeQueryPlan(scope, "query", {
    mode: "repositories",
    repositoryIds: ["github.com/dudong2/backend", "github.com/other/unknown"],
  });
  assert.ok(plan.tags.includes(scope.repositoryTag!));
  assert.ok(plan.tags.includes("scope:repo:github.com/dudong2/backend"));
  assert.ok(!plan.tags.includes("scope:repo:github.com/other/unknown"));
});
