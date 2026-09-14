import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { HindsightClient, RecallRequest } from "../src/hindsight/client.js";
import type { RetainOutbox } from "../src/hindsight/outbox.js";
import { ScopedHindsightProvider } from "../src/hindsight/provider.js";
import type { ResolvedScope } from "../src/scope/resolver.js";

const scope: ResolvedScope = {
  workspaceRoot: "/tmp/project",
  markerPath: "/tmp/project/.pi-memory-scope.json",
  marker: {
    version: 1,
    workspaceId: "ws_11111111-1111-4111-8111-111111111111",
    displayName: "project",
    repositories: ["github.com/dudong2/project"],
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
  },
  workspaceTag: "scope:workspace:ws_11111111-1111-4111-8111-111111111111",
  repositoryId: "github.com/dudong2/project",
  repositoryTag: "scope:repo:github.com/dudong2/project",
  git: null,
};

test("provider sends a strict compound scope filter to native recall", async () => {
  let request: RecallRequest | undefined;
  const client = {
    recall: async (_bank: string, value: RecallRequest) => {
      request = value;
      return { results: [{ text: "memory" }] };
    },
  } as unknown as HindsightClient;
  const provider = new ScopedHindsightProvider(DEFAULT_CONFIG, client, {} as RetainOutbox);
  const outcome = await provider.recall("query", scope);
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.memories.length, 1);
  assert.deepEqual(request?.tag_groups, [{ or: [
    { tags: [scope.workspaceTag], match: "all_strict" },
    { tags: [scope.repositoryTag], match: "all_strict" },
  ] }]);
});

test("provider recall fails open", async () => {
  const client = { recall: async () => { throw new Error("offline"); } } as unknown as HindsightClient;
  const provider = new ScopedHindsightProvider(DEFAULT_CONFIG, client, {} as RetainOutbox);
  const outcome = await provider.recall("query", scope);
  assert.deepEqual(outcome.memories, []);
  assert.equal(outcome.error, "offline");
});
