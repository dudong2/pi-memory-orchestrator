import assert from "node:assert/strict";
import test from "node:test";
import { ensureKnowledgeViews, type KnowledgeApi } from "../src/hindsight/knowledge.js";
import type { KnowledgeNode, KnowledgePageRequest } from "../src/hindsight/client.js";
import type { ResolvedScope } from "../src/scope/resolver.js";
import { GLOBAL_SCOPE_TAG } from "../src/scope/query.js";

const scope: ResolvedScope = {
  workspaceRoot: "/tmp/product",
  markerPath: "/tmp/product/.pi-memory-scope.json",
  marker: {
    version: 1,
    workspaceId: "ws_11111111-1111-4111-8111-111111111111",
    displayName: "product",
    repositories: ["github.com/dudong2/frontend"],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
  workspaceTag: "scope:workspace:ws_11111111-1111-4111-8111-111111111111",
  repositoryId: "github.com/dudong2/frontend",
  repositoryTag: "scope:repo:github.com/dudong2/frontend",
  git: null,
  scopeTag: "scope:repo:github.com/dudong2/frontend",
  kind: "repository",
  ancestors: [],
  knownRepositoryIds: ["github.com/dudong2/frontend"],
  workspaceRepositoryIds: ["github.com/dudong2/frontend"],
};

class FakeKnowledgeApi implements KnowledgeApi {
  roots: KnowledgeNode[] = [];
  pages: KnowledgePageRequest[] = [];
  next = 1;
  async knowledgeTree(): Promise<{ roots: KnowledgeNode[] }> { return { roots: this.roots }; }
  async createKnowledgeFolder(_bank: string, request: { name: string; parent_id?: string }): Promise<Record<string, unknown>> {
    const node: KnowledgeNode = { id: `node-${this.next++}`, name: request.name, kind: "folder", parent_id: request.parent_id, children: [] };
    if (request.parent_id) {
      const parent = this.find(this.roots, request.parent_id);
      parent?.children?.push(node);
    } else this.roots.push(node);
    return node;
  }
  async createKnowledgePage(_bank: string, request: KnowledgePageRequest): Promise<Record<string, unknown>> {
    const node: KnowledgeNode = { id: `node-${this.next++}`, name: request.name, kind: "page", parent_id: request.parent_id, children: [] };
    this.find(this.roots, request.parent_id!)?.children?.push(node);
    this.pages.push(request);
    return node;
  }
  find(nodes: KnowledgeNode[], id: string): KnowledgeNode | undefined {
    for (const node of nodes) {
      if (node.id === id) return node;
      const nested = this.find(node.children ?? [], id);
      if (nested) return nested;
    }
    return undefined;
  }
}

test("a repository marker creates one strictly filtered knowledge page", async () => {
  const api = new FakeKnowledgeApi();
  assert.deepEqual(await ensureKnowledgeViews(api, "bank", scope), { createdFolders: 2, createdPages: 1 });
  assert.deepEqual(await ensureKnowledgeViews(api, "bank", scope), { createdFolders: 0, createdPages: 0 });
  assert.equal(api.pages.length, 1);
  assert.deepEqual(api.pages.map((page) => page.tags), [[scope.scopeTag]]);
  for (const page of api.pages) {
    assert.equal(page.trigger?.tags_match, "all_strict");
    assert.deepEqual(page.trigger?.fact_types, ["observation"]);
    assert.equal(page.trigger?.mode, "delta");
  }
});

test("a global marker creates one shared knowledge page", async () => {
  const api = new FakeKnowledgeApi();
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
  assert.deepEqual(await ensureKnowledgeViews(api, "bank", globalScope), { createdFolders: 1, createdPages: 1 });
  assert.deepEqual(await ensureKnowledgeViews(api, "bank", globalScope), { createdFolders: 0, createdPages: 0 });
  assert.deepEqual(api.pages.map((page) => page.tags), [[GLOBAL_SCOPE_TAG]]);
});
