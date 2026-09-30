import { randomUUID } from "node:crypto";
import {
  loadDirectHindsightClient,
  createOperationWaiter,
} from "./lib/hindsight.js";
import { deterministicOperationId } from "../src/hindsight/outbox.js";

const client = loadDirectHindsightClient();
const bankId = "coding-agent::dudong2::shadow";
const token = `curationprobe-${randomUUID()}`;
const tag = `scope:workspace:${token}`;
const operationId = deterministicOperationId(token);
await client.retain(bankId, {
  async: true,
  operation_id: operationId,
  items: [
    {
      content: `${token} says the preferred package manager is yarn.`,
      timestamp: new Date().toISOString(),
      tags: [tag],
      observation_scopes: [[tag]],
      document_id: token,
      metadata: { source: "curation-smoke" },
    },
  ],
});
await createOperationWaiter(client, bankId)(operationId, 180_000);

const search = () =>
  client.recall(bankId, {
    query: token,
    types: ["world", "experience"],
    budget: "mid",
    max_tokens: 1_024,
    tag_groups: [{ tags: [tag], match: "all_strict" }],
  });
const initial = await search();
const memory = initial.results.find((item) => item.text.includes(token));
const memoryId = memory?.id ?? memory?.memory_id;
if (!memoryId) throw new Error("curation probe memory not found");
await client.updateMemory(bankId, memoryId, {
  state: "invalidated",
  reason: "curation smoke",
});
const invalidated = await search();
await client.updateMemory(bankId, memoryId, { state: "valid" });
const restored = await search();
const result = {
  foundInitially: Boolean(memoryId),
  hiddenAfterInvalidation: !invalidated.results.some((item) =>
    item.text.includes(token),
  ),
  visibleAfterRestore: restored.results.some((item) =>
    item.text.includes(token),
  ),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
