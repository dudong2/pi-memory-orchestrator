import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HindsightClient } from "../src/hindsight/client.js";
import { deterministicOperationId } from "../src/hindsight/outbox.js";

const connection = JSON.parse(readFileSync(`${process.env.HOME}/.hindsight/coding-agent.json`, "utf8")) as {
  apiUrl: string;
  apiToken: string;
};
const client = new HindsightClient({ apiUrl: connection.apiUrl, apiToken: connection.apiToken, requestTimeoutMs: 30_000 });
const bankId = "coding-agent::dudong2::shadow";
const token = `curationprobe-${randomUUID()}`;
const tag = `scope:workspace:${token}`;
const operationId = deterministicOperationId(token);
await client.retain(bankId, {
  async: true,
  operation_id: operationId,
  items: [{
    content: `${token} says the preferred package manager is yarn.`,
    timestamp: new Date().toISOString(),
    tags: [tag],
    observation_scopes: [[tag]],
    document_id: token,
    metadata: { source: "curation-smoke" },
  }],
});
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const status = await client.operationStatus(bankId, operationId);
  if (status.status === "completed") break;
  if (status.status === "failed") throw new Error("retain failed");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const search = () => client.recall(bankId, {
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
await client.updateMemory(bankId, memoryId, { state: "invalidated", reason: "curation smoke" });
const invalidated = await search();
await client.updateMemory(bankId, memoryId, { state: "valid" });
const restored = await search();
const result = {
  foundInitially: Boolean(memoryId),
  hiddenAfterInvalidation: !invalidated.results.some((item) => item.text.includes(token)),
  visibleAfterRestore: restored.results.some((item) => item.text.includes(token)),
};
console.log(JSON.stringify(result));
if (!Object.values(result).every(Boolean)) process.exitCode = 1;
