import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  resolveHindsightConnection,
  type OrchestratorConfig,
} from "../../src/config.js";
import {
  HindsightClient,
  type OperationStatus,
} from "../../src/hindsight/client.js";
import { RetainOutbox } from "../../src/hindsight/outbox.js";
import { ScopedHindsightProvider } from "../../src/hindsight/provider.js";
import { parseJson } from "../../src/json.js";

export function createScriptRuntime(
  config: OrchestratorConfig,
  outboxOptions: ConstructorParameters<typeof RetainOutbox>[0],
  requestTimeoutMs = 30_000,
) {
  const connection = resolveHindsightConnection(config);
  const client = new HindsightClient({ ...connection, requestTimeoutMs });
  const outbox = new RetainOutbox(outboxOptions);
  const provider = new ScopedHindsightProvider(config, client, outbox);
  return { connection, client, outbox, provider };
}

export function loadDirectHindsightClient(
  requestTimeoutMs = 30_000,
): HindsightClient {
  const path = join(homedir(), ".hindsight", "coding-agent.json");
  const connection = parseJson<{ apiUrl: string; apiToken?: string }>(
    readFileSync(path, "utf8"),
    path,
  );
  return new HindsightClient({
    apiUrl: connection.apiUrl,
    apiToken: connection.apiToken,
    requestTimeoutMs,
  });
}

interface WaitOptions {
  messageStyle?: "id-first" | "status-first";
  includeError?: boolean;
  pollIntervalMs?: number;
  clock?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export function createOperationWaiter(
  client: Pick<HindsightClient, "operationStatus">,
  bankId: string,
  options: WaitOptions = {},
) {
  const clock = options.clock ?? Date.now;
  const wait = options.wait ?? delay;
  return async (
    operationId: string,
    timeoutMs = 900_000,
  ): Promise<OperationStatus> => {
    const deadline = clock() + timeoutMs;
    while (clock() < deadline) {
      const operation = await client.operationStatus(bankId, operationId);
      const status = operation.status.toLowerCase();
      if (status === "completed") return operation;
      if (status === "failed" || status === "cancelled") {
        const message =
          options.messageStyle === "status-first"
            ? `operation ${status}: ${operationId}`
            : `operation ${operationId} ${status}`;
        throw new Error(
          options.includeError
            ? `${message}: ${JSON.stringify(operation.error)}`
            : message,
        );
      }
      await wait(options.pollIntervalMs ?? 500);
    }
    throw new Error(
      options.messageStyle === "status-first"
        ? `operation timed out: ${operationId}`
        : `operation ${operationId} timed out`,
    );
  };
}

export function createJsonGetter<T = unknown>(
  apiUrl: string,
  headers: RequestInit["headers"],
  timeoutMs = 30_000,
) {
  return async (path: string): Promise<T> => {
    const response = await fetch(`${apiUrl}${path}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
    return response.json() as Promise<T>;
  };
}
