import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HindsightClient } from "../src/hindsight/client.js";
import { RetainOutbox } from "../src/hindsight/outbox.js";

const connection = JSON.parse(readFileSync(`${process.env.HOME}/.hindsight/coding-agent.json`, "utf8")) as {
  apiUrl: string;
  apiToken: string;
};
const rootDir = await mkdtemp(join(tmpdir(), "memory-outbox-live-"));
const client = new HindsightClient({
  apiUrl: connection.apiUrl,
  apiToken: connection.apiToken,
  requestTimeoutMs: 30_000,
});
const outbox = new RetainOutbox({ rootDir, operationTimeoutMs: 120_000, pollIntervalMs: 500 });
const identity = `live-smoke:${new Date().toISOString()}`;
await outbox.enqueue({
  identity,
  bankId: "coding-agent::dudong2::shadow",
  item: {
    content: "The pi-memory-orchestrator live outbox probe verifies idempotent asynchronous retention.",
    context: "integration smoke test",
    timestamp: new Date().toISOString(),
    document_id: `outbox-smoke-${identity}`,
    tags: ["scope:workspace:test-outbox"],
    observation_scopes: "per_tag",
    metadata: { source: "pi-memory-orchestrator-smoke", harness: "test" },
  },
});
const result = await outbox.drain(client);
const counts = await outbox.counts();
console.log(JSON.stringify({ result, counts }));
if (result.completed !== 1 || counts.pending !== 0 || counts.processing !== 0) process.exitCode = 1;
