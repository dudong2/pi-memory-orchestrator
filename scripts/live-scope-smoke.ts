import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { HindsightClient, type RetainItem } from "../src/hindsight/client.js";
import { deterministicOperationId } from "../src/hindsight/outbox.js";

const connection = JSON.parse(readFileSync(`${process.env.HOME}/.hindsight/coding-agent.json`, "utf8")) as {
  apiUrl: string;
  apiToken: string;
};
const client = new HindsightClient({ apiUrl: connection.apiUrl, apiToken: connection.apiToken, requestTimeoutMs: 30_000 });
const bankId = "coding-agent::dudong2::shadow";
const token = `scopeprobe-${randomUUID()}`;
const workspaceTag = `scope:workspace:${token}`;
const currentTag = "scope:repo:github.com/dudong2/scope-current";
const siblingTag = "scope:repo:github.com/dudong2/scope-sibling";
const now = new Date().toISOString();

function item(label: string, tag?: string): RetainItem {
  return {
    content: `${token} ${label} fact is true.`,
    timestamp: now,
    context: "scope filter integration test",
    document_id: `${token}-${label}`,
    ...(tag ? { tags: [tag], observation_scopes: [[tag]] } : { observation_scopes: "shared" }),
    metadata: { source: "scope-filter-smoke", label },
  };
}

const operationId = deterministicOperationId(token);
await client.retain(bankId, {
  async: true,
  operation_id: operationId,
  items: [
    item("workspace-allowed", workspaceTag),
    item("current-allowed", currentTag),
    item("sibling-blocked", siblingTag),
    item("untagged-blocked"),
  ],
});

const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const status = await client.operationStatus(bankId, operationId);
  if (status.status === "completed") break;
  if (status.status === "failed" || status.status === "cancelled") throw new Error(`retain ${status.status}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (Date.now() >= deadline) throw new Error("scope smoke retain timed out");

const response = await client.recall(bankId, {
  query: token,
  budget: "mid",
  max_tokens: 2_048,
  types: ["world", "experience", "observation"],
  tag_groups: [{ or: [
    { tags: [workspaceTag], match: "all_strict" },
    { tags: [currentTag], match: "all_strict" },
  ] }],
});
const text = response.results.map((memory) => memory.text).join("\n");
const result = {
  count: response.results.length,
  workspaceAllowed: text.includes("workspace-allowed"),
  currentAllowed: text.includes("current-allowed"),
  siblingBlocked: !text.includes("sibling-blocked"),
  untaggedBlocked: !text.includes("untagged-blocked"),
};
console.log(JSON.stringify(result));
if (!Object.values(result).every((value) => typeof value === "number" || value === true)) process.exitCode = 1;
